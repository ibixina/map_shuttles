import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { mergeResults, searchPhoton, type LocalIndex, type Place } from '../lib/search';
import { CloseIcon, SearchIcon } from './icons';

const DEBOUNCE_MS = 250;
const MIN_REMOTE_CHARS = 3;

export interface QuickOption {
  id: string;
  label: string;
  sub?: string;
  /** A heading shown above this option when it differs from the one before. */
  group?: string;
  onSelect(): void;
}

interface Props {
  index: LocalIndex | null;
  value: string;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  /** Offered when the box is focused and empty. */
  quickOptions?: QuickOption[];
  leading?: ReactNode;
  /** Shown at the end of the field, such as a directions button. */
  trailing?: ReactNode;
  /** Only places you can stand at: leaves out whole routes. */
  placesOnly?: boolean;
  onPick(place: Place): void;
  onClear?(): void;
}

export function SearchBox({ index, value, placeholder, ariaLabel, autoFocus, quickOptions = [], leading, trailing, placesOnly, onPick, onClear }: Props) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<Place[]>([]);
  const [remoteFor, setRemoteFor] = useState('');
  const [remoteFailed, setRemoteFailed] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  // An outside change (a new destination, swapping from and to) replaces the text.
  useEffect(() => setText(value), [value]);

  const query = text.trim();
  const editing = open && query !== value.trim();
  const local = useMemo(() => {
    if (!index || !editing) return [];
    const found = index.search(query, 10);
    return (placesOnly ? found.filter((p) => p.kind !== 'cdta-route') : found).slice(0, 8);
  }, [index, query, editing, placesOnly]);

  useEffect(() => {
    if (!editing || query.length < MIN_REMOTE_CHARS) {
      setRemote([]);
      setRemoteFor('');
      setRemoteFailed(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchPhoton(query, controller.signal).then(
        (places) => {
          setRemote(places);
          setRemoteFor(query);
          setRemoteFailed(false);
        },
        (error: Error) => {
          if (error.name === 'AbortError') return;
          setRemote([]);
          setRemoteFor(query);
          setRemoteFailed(true);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, editing]);

  const results = editing ? mergeResults(local, remoteFor === query ? remote : []) : [];
  const showQuick = open && !editing && quickOptions.length > 0 && (query === '' || query === value.trim());
  const searching = editing && query.length >= MIN_REMOTE_CHARS && remoteFor !== query;
  const showEmpty = editing && query.length > 0 && results.length === 0 && !searching;
  const items = showQuick ? quickOptions.length : results.length;

  useEffect(() => setActive(-1), [query, open]);

  const choose = (place: Place) => {
    setOpen(false);
    setText(place.name);
    input.current?.blur();
    onPick(place);
  };
  const chooseQuick = (option: QuickOption) => {
    setOpen(false);
    input.current?.blur();
    option.onSelect();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % items : (i - 1 + items) % items));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (showQuick) {
        if (active >= 0) chooseQuick(quickOptions[active]);
        return;
      }
      const target = results[Math.max(active, 0)];
      if (target) choose(target);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setText(value);
    }
  };

  return (
    <div className={`searchbox ${open && (results.length || showQuick || showEmpty) ? 'is-open' : ''}`}>
      <div className="searchbox-field">
        {leading ?? <SearchIcon size={17} />}
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded={open && items > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={(e) => {
            setOpen(true);
            e.target.select();
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
        {(text || value) && onClear && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setText('');
              onClear();
              input.current?.focus();
            }}
          >
            <CloseIcon size={16} />
          </button>
        )}
        {trailing}
      </div>
      {open && (results.length > 0 || showQuick || showEmpty) && (
        <ul className="searchbox-results" id={listId} role="listbox">
          {showQuick &&
            quickOptions.flatMap((option, i) => [
              ...(option.group && option.group !== quickOptions[i - 1]?.group
                ? [<li key={`group:${option.group}`} className="group" role="presentation">{option.group}</li>]
                : []),
              <li key={option.id} id={`${listId}-${i}`} role="option" aria-selected={active === i} className={active === i ? 'is-active' : ''}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => chooseQuick(option)}>
                  <span>{option.label}</span>
                  {option.sub && <small>{option.sub}</small>}
                </button>
              </li>,
            ])}
          {!showQuick &&
            results.map((place, i) => (
              <li key={place.id} id={`${listId}-${i}`} role="option" aria-selected={active === i} className={active === i ? 'is-active' : ''}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(place)}>
                  <span>{place.name}</span>
                  {place.subtitle && <small>{place.subtitle}</small>}
                </button>
              </li>
            ))}
          {showEmpty && (
            <li className="searchbox-empty" role="presentation">
              {remoteFailed
                ? 'Address search is unavailable. Campus buildings and stops still work.'
                : `Nothing found for “${query}” around Troy.`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
