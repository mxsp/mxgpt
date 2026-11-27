'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const MAX_NOTES = 200;

function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAll(notes) {
  const tmp = `${NOTES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
  fs.renameSync(tmp, NOTES_FILE);
}

function ownedBy(note, owner) {
  return owner === undefined || owner === null || (note.owner || 'owner') === owner;
}

function list(owner = 'owner') {
  return loadAll()
    .filter((n) => ownedBy(n, owner))
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

function find(idOrTitle, owner = 'owner') {
  const needle = String(idOrTitle || '').trim().toLowerCase();
  if (!needle) return null;
  const mine = list(owner);
  return (
    mine.find((n) => n.id === idOrTitle) ||
    mine.find((n) => n.title.toLowerCase() === needle) ||
    mine.find((n) => n.title.toLowerCase().includes(needle)) ||
    null
  );
}

function save({ id, title, content, tags = [] }, owner = 'owner') {
  const cleanTitle = String(title || '').trim().slice(0, 120);
  const cleanContent = String(content || '').trim().slice(0, 20000);
  if (!cleanTitle) throw new Error('Note title is required');
  if (!cleanContent) throw new Error('Note content is required');
  const cleanTags = (Array.isArray(tags) ? tags : String(tags || '').split(','))
    .map((t) => String(t).trim().toLowerCase().slice(0, 32))
    .filter(Boolean)
    .slice(0, 10);

  const all = loadAll();
  const now = Date.now();
  let existing = id
    ? all.find((n) => n.id === id && ownedBy(n, owner))
    : all.find((n) => ownedBy(n, owner) && n.title.toLowerCase() === cleanTitle.toLowerCase());

  if (existing) {
    existing.title = cleanTitle;
    existing.content = cleanContent;
    existing.tags = cleanTags;
    existing.updated = now;
    saveAll(all);
    return existing;
  }

  const mineCount = all.filter((n) => ownedBy(n, owner)).length;
  if (mineCount >= MAX_NOTES) throw new Error(`Note limit reached (${MAX_NOTES})`);

  const note = {
    id: 'n' + now.toString(36) + crypto.randomBytes(3).toString('hex'),
    owner,
    title: cleanTitle,
    content: cleanContent,
    tags: cleanTags,
    created: now,
    updated: now,
  };
  all.push(note);
  saveAll(all);
  return note;
}

function remove(idOrTitle, owner = 'owner') {
  const target = find(idOrTitle, owner);
  if (!target) return false;
  const all = loadAll().filter((n) => n.id !== target.id);
  saveAll(all);
  return true;
}

function search(query, owner = 'owner') {
  const needle = String(query || '').trim().toLowerCase();
  const mine = list(owner);
  if (!needle) return mine;
  return mine.filter(
    (n) =>
      n.title.toLowerCase().includes(needle) ||
      n.content.toLowerCase().includes(needle) ||
      (n.tags || []).some((t) => t.includes(needle))
  );
}

module.exports = { list, find, save, remove, search };
