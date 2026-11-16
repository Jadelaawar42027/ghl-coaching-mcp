import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, stripQuotedReply, emailBodyToText, EMAIL_BODY_MAX_CHARS } from '../email-text.js';

describe('htmlToText', () => {
  test('keeps paragraphs and decodes entities', () => {
    const html = '<html><head><style>p{}</style></head><body><p>Hi Jay,</p><p>Budget is $2M &amp; we fly in Friday.</p></body></html>';
    assert.equal(htmlToText(html), 'Hi Jay,\nBudget is $2M & we fly in Friday.');
  });
});

describe('stripQuotedReply', () => {
  test('cuts Gmail-style quoted history but keeps the new text', () => {
    const r = stripQuotedReply('Sounds good, Thursday works.\n\nOn Mon, Nov 16, 2026 at 9:00 AM Jay <jay@365yachts.org> wrote:\n> Are you free Thursday?');
    assert.equal(r.text, 'Sounds good, Thursday works.');
    assert.equal(r.removedQuote, true);
  });
  test('cuts Outlook headers only when From: is followed by Sent:', () => {
    const outlook = stripQuotedReply('Yes please send the specs.\nFrom: Jay Johnson\nSent: Monday\nTo: Jane\nSubject: Specs');
    assert.equal(outlook.text, 'Yes please send the specs.');
    const notQuote = stripQuotedReply('Details below.\nFrom: Miami to Bimini is our plan.\nWe want a 60ft.');
    assert.equal(notQuote.removedQuote, false);
  });
  test('never removes the whole email', () => {
    assert.equal(stripQuotedReply('> only a quote').text, '> only a quote');
  });
});

describe('emailBodyToText', () => {
  test('plain text passes through', () => {
    assert.equal(emailBodyToText('We are ready to make an offer.').text, 'We are ready to make an offer.');
  });
  test('long emails are capped and marked', () => {
    const r = emailBodyToText('a'.repeat(EMAIL_BODY_MAX_CHARS + 50));
    assert.equal(r.truncated, true);
    assert.match(r.text, /email continues/);
  });
});
