import { shared } from '../shared.js';
export async function loadItems() {
  return fetch('http://service-b.invalid/items').then(response => response.json()).then(shared);
}
