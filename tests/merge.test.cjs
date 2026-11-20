const test = require('node:test');
const assert = require('node:assert/strict');
const {merge, same} = require('../sync-core.js');
const film = (id, note = '', rating = 0) => ({id, note, rating});
const archive = (...films) => ({collections: [{id:'collection-a', films}], paths: [], settings: {motion:'system'}});

test('merges independent edits and independent additions', () => {
  const base = archive(film('a'), film('b'));
  const local = archive(film('a', 'local note'), film('b'), film('c'));
  const remote = archive(film('a', '', 4), film('b', 'remote note'), film('d'));
  const result = merge(base, local, remote);
  assert.deepEqual(result.collections[0].films.map(f => f.id), ['a','b','d','c']);
  assert.deepEqual(result.collections[0].films[0], film('a', 'local note', 4));
  assert.equal(result.collections[0].films[1].note, 'remote note');
});

test('deletion wins over a stale concurrent edit without resurrecting the film', () => {
  const base = archive(film('a'), film('b'));
  const local = archive(film('a', 'edited while offline'), film('b', 'kept'));
  const remote = archive(film('b'));
  assert.deepEqual(merge(base, local, remote).collections[0].films, [film('b', 'kept')]);
  assert.deepEqual(merge(base, remote, local).collections[0].films, [film('b', 'kept')]);
});

test('a conflict on one field takes the edit being committed later', () => {
  assert.equal(merge({note:'old'}, {note:'later'}, {note:'first'}).note, 'later');
});

test('preserves relationships and combines separate ID-keyed paths', () => {
  const base = {paths:[]};
  const local = {paths:[{id:'p1',collectionId:'c1',filmIds:['f1']}]};
  const remote = {paths:[{id:'p2',collectionId:'c1',filmIds:['f2']}]};
  assert.deepEqual(merge(base,local,remote).paths.map(p => p.id), ['p2','p1']);
});

test('reorders locally while retaining a remote insertion', () => {
  const base = archive(film('a'),film('b'));
  const local = archive(film('b'),film('a'));
  const remote = archive(film('a'),film('b'),film('c'));
  assert.deepEqual(merge(base,local,remote).collections[0].films.map(f=>f.id), ['b','a','c']);
});

test('comparison ignores object key order but respects array order', () => {
  assert.ok(same({a:1,b:{x:2,y:3}},{b:{y:3,x:2},a:1}));
  assert.ok(!same([1,2],[2,1]));
});
