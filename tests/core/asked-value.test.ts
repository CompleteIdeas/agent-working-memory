import { describe, it, expect } from 'vitest';
import { askedKinds, missingAskedKinds, missingValueNote } from '../../src/core/asked-value.js';

const r = (content: string) => ({ engram: { content } });

describe('askedKinds', () => {
  it('reads the kind of value a question asks for', () => {
    expect([...askedKinds("what time does Sam's Denver flight leave")]).toEqual(['time']);
    expect([...askedKinds('how much is the standard rose now')]).toEqual(['money']);
    expect([...askedKinds('what day is the museum trip')]).toEqual(['date']);
    expect([...askedKinds('which port does the API listen on')]).toEqual(['number']);
    expect([...askedKinds('is the hotel invoice paid')]).toEqual(['status']);
  });
  it('"when" accepts a time or a date', () => {
    expect([...askedKinds('when is the dentist appointment')].sort()).toEqual(['date', 'time']);
  });
  it('is empty when the question names no kind', () => {
    expect(askedKinds('who is the rose supplier').size).toBe(0);
    expect(askedKinds('tell me about the Denver trip').size).toBe(0);
  });
});

describe('missingAskedKinds — the near-miss', () => {
  const flightNoTime = [
    r("Sam's Denver flight UA 1432 is on Nov 14 from Dulles."),
    r('Sam flies to Denver for the conference; hotel is the Grand.'),
    r('Sam wants an aisle seat on the Denver flight.'),
  ];
  it('flags a time question when the memories hold no time', () => {
    expect(missingAskedKinds("what time does Sam's Denver flight leave", flightNoTime)).toEqual(['time']);
  });
  it('is satisfied by any result that holds the kind', () => {
    const withTime = [...flightNoTime, r("Sam's Denver flight departs at 8:40 AM.")];
    expect(missingAskedKinds("what time does Sam's Denver flight leave", withTime)).toEqual([]);
  });
  it('"when" is satisfied by a date alone', () => {
    expect(missingAskedKinds('when is the Denver flight', flightNoTime)).toEqual([]);
  });
  it('a money question with only a date stored is flagged', () => {
    expect(missingAskedKinds('how much is the rose per stem', [r('Rose order is due Nov 6 from Bloomberg Wholesale.')])).toEqual(['money']);
  });
  it('says nothing for a question that names no kind, or for no results', () => {
    expect(missingAskedKinds('who is the rose supplier', flightNoTime)).toEqual([]);
    expect(missingAskedKinds('what time is standup', [])).toEqual([]);
  });
  it('renders one line naming what is missing', () => {
    const note = missingValueNote("what time does Sam's Denver flight leave", flightNoTime);
    expect(note).toContain('none of them holds a time');
    expect(note).toContain('read the source');
    expect(missingValueNote('who is the rose supplier', flightNoTime)).toBe('');
  });
});
