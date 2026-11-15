import { expect, open, test } from 'nsh/test';
test('the actual composer submits a custom question answer', async () => {
 const app=await open('./UserInputComposerFixture.tsx',{width:800,height:600,platform:'macos'});
 await app.type('id:composer-prompt','hello');
 await expect(app.enabled('label:Submit answers')).toBe(true);
 await app.press('label:Submit answers');
 await app.waitFor('text:{"answer":"hello"}');
 await expect(app.texts()).toContain('draft:saved draft');
});
