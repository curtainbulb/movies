/* Three-way reconciliation of the application's JSON archive. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NightreelMerge = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const absent = Symbol('absent');
  function same(a, b) {
    if (a === b) return true;
    if (a === absent || b === absent || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((item, index) => same(item, b[index]));
    const aKeys = Object.keys(a), bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  const copy = value => value === absent ? absent : structuredClone(value);
  const object = value => value !== absent && value !== null && typeof value === 'object' && !Array.isArray(value);
  const keyed = arrays => {
    const elements = arrays.flatMap(array => array === absent ? [] : array);
    return elements.length > 0 && elements.every(item => object(item) && typeof item.id === 'string' && item.id.length > 0) && arrays.every(array => array === absent || new Set(array.map(item => item.id)).size === array.length);
  };

  function merge(base, local, remote) {
    if (same(local, remote)) return copy(local);
    if (same(local, base)) return copy(remote);
    if (same(remote, base)) return copy(local);
    // An entity deleted on either device stays deleted when the other device edited it.
    if (base !== absent && (local === absent || remote === absent)) return absent;
    if (Array.isArray(local) && Array.isArray(remote) && (base === absent || Array.isArray(base)) && keyed([base, local, remote])) {
      const old = new Map((base === absent ? [] : base).map(item => [item.id, item]));
      const ours = new Map(local.map(item => [item.id, item]));
      const theirs = new Map(remote.map(item => [item.id, item]));
      const baseOrder = [...old.keys()].filter(id => ours.has(id) && theirs.has(id));
      const localOrder = [...ours.keys()].filter(id => old.has(id) && theirs.has(id));
      const localReordered = JSON.stringify(baseOrder) !== JSON.stringify(localOrder);
      const order = localReordered ? [...ours.keys(), ...theirs.keys()] : [...theirs.keys(), ...ours.keys()];
      const result = [];
      for (const id of new Set(order)) {
        const entry = merge(old.has(id) ? old.get(id) : absent, ours.has(id) ? ours.get(id) : absent, theirs.has(id) ? theirs.get(id) : absent);
        if (entry !== absent) result.push(entry);
      }
      return result;
    }
    if (object(local) && object(remote) && (base === absent || object(base))) {
      const result = {};
      const keys = new Set([...Object.keys(base === absent ? {} : base), ...Object.keys(remote), ...Object.keys(local)]);
      for (const key of keys) {
        const entry = merge(base !== absent && Object.hasOwn(base, key) ? base[key] : absent, Object.hasOwn(local, key) ? local[key] : absent, Object.hasOwn(remote, key) ? remote[key] : absent);
        if (entry !== absent) result[key] = entry;
      }
      return result;
    }
    // A conflicting scalar or non-ID array takes the later successfully committed edit.
    return copy(local);
  }
  return {merge, same};
});
