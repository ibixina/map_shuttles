// A small GTFS-realtime decoder: only the fields this app reads. The official bindings
// pull in a large protobuf runtime, far more than a phone needs to download for this.
// tests/transit.test.ts checks it against those bindings using real captured feeds.

const OCCUPANCY = ['EMPTY', 'MANY_SEATS_AVAILABLE', 'FEW_SEATS_AVAILABLE', 'STANDING_ROOM_ONLY', 'CRUSHED_STANDING_ROOM_ONLY', 'FULL', 'NOT_ACCEPTING_PASSENGERS'];
const VEHICLE_STATUS = ['INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO'];
const STOP_RELATIONSHIP = ['SCHEDULED', 'SKIPPED', 'NO_DATA', 'UNSCHEDULED'];

const decoder = new TextDecoder();

/** Calls onField(fieldNumber, value) for each field in bytes[start, end). */
function readMessage(bytes, start, end, onField) {
  let pos = start;
  const varint = () => {
    let result = 0;
    let scale = 1;
    let byte;
    do {
      byte = bytes[pos++];
      result += (byte & 0x7f) * scale; // Not bit shifts: uint64 timestamps can exceed 32 bits.
      scale *= 128;
    } while (byte & 0x80);
    return result;
  };
  while (pos < end) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    switch (tag & 7) {
      case 0:
        onField(field, varint());
        break;
      case 1:
        onField(field, null, pos);
        pos += 8;
        break;
      case 2: {
        const length = varint();
        onField(field, null, pos, pos + length);
        pos += length;
        break;
      }
      case 5:
        onField(field, null, pos);
        pos += 4;
        break;
      default:
        throw new Error('Unsupported protobuf wire type');
    }
  }
}

function decodeAll(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (a, b) => decoder.decode(bytes.subarray(a, b));

  const tripDescriptor = (a, b) => {
    const trip = {};
    readMessage(bytes, a, b, (f, _v, s, e) => {
      if (f === 1) trip.tripId = text(s, e);
      else if (f === 2) trip.startTime = text(s, e);
      else if (f === 3) trip.startDate = text(s, e);
      else if (f === 5) trip.routeId = text(s, e);
    });
    return trip;
  };
  const vehicleDescriptor = (a, b) => {
    const vehicle = {};
    readMessage(bytes, a, b, (f, _v, s, e) => {
      if (f === 1) vehicle.id = text(s, e);
      else if (f === 2) vehicle.label = text(s, e);
    });
    return vehicle;
  };
  const position = (a, b) => {
    const out = {};
    readMessage(bytes, a, b, (f, _v, s) => {
      if (f === 1) out.latitude = view.getFloat32(s, true);
      else if (f === 2) out.longitude = view.getFloat32(s, true);
    });
    return out;
  };
  const vehiclePosition = (a, b) => {
    const out = {};
    readMessage(bytes, a, b, (f, v, s, e) => {
      if (f === 1) out.trip = tripDescriptor(s, e);
      else if (f === 2) out.position = position(s, e);
      else if (f === 3) out.currentStopSequence = v;
      else if (f === 4) out.currentStatus = VEHICLE_STATUS[v];
      else if (f === 5) out.timestamp = v;
      else if (f === 8) out.vehicle = vehicleDescriptor(s, e);
      else if (f === 9) out.occupancyStatus = OCCUPANCY[v];
    });
    return out;
  };
  const stopTimeEvent = (a, b) => {
    const out = {};
    readMessage(bytes, a, b, (f, v) => {
      if (f === 2) out.time = v;
    });
    return out;
  };
  const stopTimeUpdate = (a, b) => {
    const out = {};
    readMessage(bytes, a, b, (f, v, s, e) => {
      if (f === 1) out.stopSequence = v;
      else if (f === 2) out.arrival = stopTimeEvent(s, e);
      else if (f === 3) out.departure = stopTimeEvent(s, e);
      else if (f === 4) out.stopId = text(s, e);
      else if (f === 5) out.scheduleRelationship = STOP_RELATIONSHIP[v];
    });
    return out;
  };
  const tripUpdate = (a, b) => {
    const out = { stopTimeUpdate: [] };
    readMessage(bytes, a, b, (f, _v, s, e) => {
      if (f === 1) out.trip = tripDescriptor(s, e);
      else if (f === 2) out.stopTimeUpdate.push(stopTimeUpdate(s, e));
      else if (f === 3) out.vehicle = vehicleDescriptor(s, e);
    });
    return out;
  };
  const translated = (a, b) => {
    const out = { translation: [] };
    readMessage(bytes, a, b, (f, _v, s, e) => {
      if (f !== 1) return;
      const item = {};
      readMessage(bytes, s, e, (g, _w, x, y) => {
        if (g === 1) item.text = text(x, y);
        else if (g === 2) item.language = text(x, y);
      });
      out.translation.push(item);
    });
    return out;
  };
  const informedEntity = (a, b) => {
    const out = {};
    readMessage(bytes, a, b, (f, _v, s, e) => {
      if (f === 2) out.routeId = text(s, e);
      else if (f === 5) out.stopId = text(s, e);
    });
    return out;
  };
  const alert = (a, b) => {
    const out = { informedEntity: [] };
    readMessage(bytes, a, b, (f, _v, s, e) => {
      if (f === 5) out.informedEntity.push(informedEntity(s, e));
      else if (f === 8) out.url = translated(s, e);
      else if (f === 10) out.headerText = translated(s, e);
      else if (f === 11) out.descriptionText = translated(s, e);
    });
    return out;
  };

  const message = { header: {}, entity: [] };
  readMessage(bytes, 0, bytes.length, (f, _v, s, e) => {
    if (f === 1) {
      readMessage(bytes, s, e, (g, v) => {
        if (g === 3) message.header.timestamp = v;
      });
    } else if (f === 2) {
      const entity = {};
      readMessage(bytes, s, e, (g, _w, x, y) => {
        if (g === 1) entity.id = text(x, y);
        else if (g === 3) entity.tripUpdate = tripUpdate(x, y);
        else if (g === 4) entity.vehicle = vehiclePosition(x, y);
        else if (g === 5) entity.alert = alert(x, y);
      });
      message.entity.push(entity);
    }
  });
  return message;
}

export { decodeAll as decodeFeedMessage };
