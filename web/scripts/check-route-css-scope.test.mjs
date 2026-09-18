/* Run: npm run test:route-css */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectorIsScoped, selectorsOf, routeStylesheets } from './check-route-css-scope.mjs';

test('the selectors that leaked the weigh-in hero onto /algo are rejected', () => {
  for (const s of ['.page > section:first-of-type', '.page > section:first-of-type::after', '.page > .crumbs', '.wrap h1', '.row', '.card.hi', 'section:first-of-type', 'h1', 'h2 > a', '*', '#record', ':root', 'body .x', '[data-x] p']) {
    assert.equal(selectorIsScoped(s), false, s);
  }
});

test('a route-namespaced selector is accepted, however generic the rest of it is', () => {
  for (const s of ['.weighins-cinematic-page > section:first-of-type::after', '.weighins-cinematic-page > .crumbs a:hover', '.weighins-cinematic-page h1']) {
    assert.equal(selectorIsScoped(s), true, s);
  }
});

test('the parser reads selector lists, skips at-rules, comments, declarations and keyframe stops', () => {
  const css = `/* .page > h1 { } */
  @media (max-width: 640px) { .page > a, .ok-scope b { color: red; content: "x{y}"; } }
  @keyframes k { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }`;
  assert.deepEqual(selectorsOf(css).map((s) => s.selector), ['.page > a', '.ok-scope b']);
});

test('every route-level stylesheet in the app is fully scoped', () => {
  const sheets = routeStylesheets();
  assert.ok([...sheets.keys()].some((f) => /weighins-cinematic\.css$/.test(f)), 'the weigh-ins cinematic sheet is discovered');
  for (const [css] of sheets) {
    const bad = selectorsOf(readFileSync(css, 'utf8')).filter((s) => !selectorIsScoped(s.selector));
    assert.deepEqual(bad, [], css);
  }
});
