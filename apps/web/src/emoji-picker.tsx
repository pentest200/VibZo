import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './ui.js';
const categories = ['Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink', 'Travel & Places', 'Activities', 'Objects', 'Symbols', 'Flags', 'Component'];
const symbols = ['😀', '👋', '🐻', '🍔', '🚗', '⚽', '💡', '❤️', '🏳️', '🏽'];
export function EmojiPicker({ insert, close }: { insert: (emoji: string) => void; close: () => void }) {
  const [rows, setRows] = useState<string[][]>([]), [error, setError] = useState(false), [search, setSearch] = useState(''), [category, setCategory] = useState(categories[0]!), [limit, setLimit] = useState(120), [tone, setTone] = useState('all');
  const field = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  useEffect(() => { field.current?.focus(); let active = true; void import('./emoji/catalogue.json').then(result => { if (active) setRows(result.default); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, []);
  const filtered = useMemo(() => {
    const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return rows.filter(([emoji = '', name = '', group]) => (words.length ? words.every(word => `${name} ${emoji}`.toLowerCase().includes(word)) : group === category) && (tone === 'all' || tone === 'default' ? tone !== 'default' || !/[\u{1F3FB}-\u{1F3FF}]/u.test(emoji) : emoji.includes(tone)));
  }, [rows, search, category, tone]);
  function reset() { setLimit(120); if (list.current) list.current.scrollTop = 0; }
  return <div className="emoji-picker" role="group" aria-label="Emoji" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <div className="emoji-search"><Icon name="search" size={18} /><input ref={field} aria-label="Search emoji" placeholder="Search emoji" value={search} onChange={event => { setSearch(event.target.value); reset(); }} /><button type="button" className="icon-button" aria-label="Close emoji" onClick={close}><Icon name="close" size={18} /></button></div>
    <div className="emoji-categories" role="group" aria-label="Emoji categories">{categories.map((name, index) => <button type="button" key={name} aria-label={name} title={name} aria-pressed={!search && category === name} onClick={() => { setCategory(name); setSearch(''); reset(); }}>{symbols[index]}</button>)}</div>
    <div className="emoji-filter"><span>{search ? 'Search results' : category}</span><label><span className="sr-only">Skin tone</span><select aria-label="Skin tone" value={tone} onChange={event => { setTone(event.target.value); reset(); }}><option value="all">All tones</option><option value="default">Default</option>{['🏻', '🏼', '🏽', '🏾', '🏿'].map(value => <option key={value} value={value}>{value}</option>)}</select></label></div>
    <div className="emoji-results" ref={list} onScroll={event => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 80 && limit < filtered.length) setLimit(current => current + 120); }}>
      {filtered.slice(0, limit).map(([emoji = '', name]) => <button type="button" key={emoji} aria-label={`Insert ${emoji}`} title={name} onClick={() => insert(emoji)}>{emoji}</button>)}
      {!rows.length && <p role="status">{error ? 'Emoji catalogue unavailable. Close and try again.' : 'Loading emoji…'}</p>}{rows.length > 0 && !filtered.length && <p>No emoji found.</p>}
      {limit < filtered.length && <button type="button" className="emoji-more" onClick={() => setLimit(current => current + 120)}>More emoji</button>}
    </div><small className="emoji-footer">{filtered.length.toLocaleString()} emoji · Unicode 17.0</small>
  </div>;
}
