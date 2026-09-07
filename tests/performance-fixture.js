/* Runs only on the isolated test server, before the app script. */
const fixtureParams = new URLSearchParams(location.search);
const fixtureCount = Math.min(10000, Math.max(20, Number(fixtureParams.get('count')) || 2000));
const fixtureRows = Array.from({ length: fixtureCount }, (_, i) => ({
  id: 2000000000000 - i, type: 'posts', author: 'Creator ' + i, platform: i % 2 ? 'X' : 'LinkedIn',
  date: 'Sep 6, 2026', text: 'Swipe ' + i + '. ' + 'A useful example of a writing framework and design reference. '.repeat(i % 8 + 1),
  filters: { Category: i % 2 ? 'Design' : 'Strategy', Format: i % 5 ? 'Single image' : 'Carousel',
    Topic: Array.from({ length: i % 5 }, (_, j) => 'Topic ' + j) },
  image: i === 1 ? location.origin + '/expired-image.png' : i % 9 === 8 ? '' : Array.from({ length: i % 5 ? 1 : 12 }, (_, j) => location.origin + '/image.svg?slide=' + (j + 1)).join(','),
  postUrl: 'https://example.com/post/' + i, reactions: i * 3, comments: i % 42, reposts: i % 20
}));
fixtureRows.push({ id: 42, type: 'creators', author: 'Fixture creator', text: 'Test bio', platform: 'X', followers: 1234, filters: {} });
fixtureRows.push({ id: 43, type: 'websites', author: 'Fixture website', text: 'Test notes', postUrl: 'https://example.com', filters: {} });
fixtureRows.push({ id: 44, type: 'snippets', author: 'Fixture snippet', text: 'A short writing framework', filters: {} });
localStorage.clear(); // Isolated localhost origin only.
localStorage.setItem('swipeardy_layout_v1', JSON.stringify(fixtureParams.get('layout') || 'masonry'));
localStorage.setItem('swipeardy_swipes_v1', JSON.stringify(fixtureRows.filter(r => r.type === 'posts')));
window.fixtureWrites = [];
window.fixtureErrors = [];
window.addEventListener('error', e => fixtureErrors.push(e.message));
window.addEventListener('unhandledrejection', e => fixtureErrors.push(String(e.reason)));
window.confirm = () => true;
window.fixtureOriginalFetch = window.fetch.bind(window);
window.fetch = async (input, options = {}) => {
  const url = String(input);
  if (!url.startsWith('https://dmhiitzunsdqyxopqsby.supabase.co/rest/v1')) {
    if (url.startsWith(location.origin) || url.startsWith('/')) return fixtureOriginalFetch(input, options);
    throw new Error('Test blocked an external request');
  }
  if (options.method && options.method !== 'GET') {
    fixtureWrites.push({ url, method: options.method, body: options.body });
    return new Response('[]', { status: 200 });
  }
  if (url.includes('/swipes')) return new Response(JSON.stringify(fixtureRows), { status: 200 });
  return new Response('[]', { status: 200 });
};
window.supabase = { createClient: () => ({
  auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => {},
    signOut: async () => {}, signInWithPassword: async () => ({ data: { session: null } }) },
  channel: () => ({ on() { return this; }, subscribe() { return this; } })
}) };
