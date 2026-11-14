// Copyright 2026 Robert Winter / Complete Ideas
// SPDX-License-Identifier: Apache-2.0
/**
 * Entity-name eval (0.23): does AWM_ENTITY_ALIAS_MATCH=1 let ordinary questions that name a
 * person, organisation or situation in lowercase ("what did jenna want", "when is the gala")
 * reach the memories about it?
 *
 * A synthetic mailbox for one agent: 6 people (two share the first name Jenna), 2
 * organisations, 2 situations, each tagged the way MWA tags mail (contact=<email>, org=,
 * event=) with aliases registered; plus distractors that share the questions' vocabulary
 * and a look-alike sender (harborhoteI.example, capital I) that must NOT resolve to the real
 * hotel. The gold memories mostly do not contain the name the question uses: that is the
 * case only the alias route can bridge.
 *
 * Both arms run in one process on one store, interleaved per question, so they share warm
 * models and the same scores. Reports success@1, success@5, how often the flag injected an
 * entity the question did not name, and p50/p95 recall latency.
 *
 * Run: npx tsx tests/entity-eval/runner.ts         (writes tests/entity-eval/results.json)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngramStore } from '../../src/storage/sqlite.js';
import { ActivationEngine } from '../../src/engine/activation.js';
import { ConnectionEngine } from '../../src/engine/connections.js';
import { performWrite } from '../../src/core/write-pipeline.js';
import { registerAlias } from '../../src/engine/entity-about.js';
import { entityQueryGrams, selectEntityHits } from '../../src/core/entity-extract.js';

// The configuration `awm setup` installs (as scripts/bench-current.mjs measures it).
Object.assign(process.env, { AWM_RERANK2: '1', AWM_RERANK_WINDOW: 'query', AWM_RERANK_TAGS: '1', AWM_MODEL_DAEMON: '0' });
delete process.env.AWM_ENTITY_INDEX_FETCH;

const AGENT = 'maya';
const HOTEL_JENNA = 'contact:events@harborhotel.example';
const FAKE_HOTEL = 'contact:events@harborhotei.example'; // what "events@harborhoteI.example" normalises to
const PHOTO_JENNA = 'contact:jenna@lensandlight.example';
const LEO = 'person:leo martinez';
const PRIYA = 'contact:priya@greenstem.example';
const TOM = 'contact:tom@beckerlaw.example';
const DANA = 'contact:dana@sunrisebank.example';
const HOTEL = 'org:harbor hotel';
const GREENSTEM = 'org:greenstem wholesale';
const GALA = 'event:harbor hotel gala';
const MARKET = 'event:spring market';

const ALIASES: Array<[string, string]> = [
  ['jenna', HOTEL_JENNA], ['jenna park', HOTEL_JENNA], ['the events manager', HOTEL_JENNA],
  ['jenna liu', PHOTO_JENNA], ['the photographer', PHOTO_JENNA],
  ['leo', LEO],
  ['priya', PRIYA], ['the florist', PRIYA],
  ['tom', TOM], ['tom becker', TOM], ['the lawyer', TOM],
  ['dana', DANA], ['the bank', DANA],
  ['the hotel', HOTEL], ['harbor hotel', HOTEL],
  ['greenstem', GREENSTEM], ['the wholesaler', GREENSTEM],
  ['the gala', GALA], ['gala', GALA],
  ['the market', MARKET], ['spring market', MARKET],
];

// key → [concept, content, tags]. Keys are referenced by the questions' gold.
type Mem = { key: string; concept: string; content: string; tags: string[]; validFrom?: string };
const t = (...xs: string[]) => xs.map(x => {
  const i = x.indexOf(':'); return `${x.slice(0, i)}=${x.slice(i + 1)}`;
});
const MEMS: Mem[] = [
  // Jenna Park, events manager (the hotel)
  { key: 'jp-confirm', concept: 'Centerpiece confirmation due Fri Nov 6', content: 'Events manager asked us to confirm the centerpiece design and count by Friday Nov 6.', tags: t(HOTEL_JENNA, GALA), validFrom: '2026-11-02' },
  { key: 'jp-loadin', concept: 'Ballroom load-in window', content: 'Load-in for the ballroom is 2pm to 4pm on the day; use the service entrance on Pier Street.', tags: t(HOTEL_JENNA, GALA), validFrom: '2026-11-03' },
  { key: 'jp-tablecount', concept: 'Table count raised to 32', content: 'She raised the table count from 28 to 32 after the late RSVPs.', tags: t(HOTEL_JENNA, GALA), validFrom: '2026-11-04' },
  { key: 'jp-signature', concept: 'Events Manager signature', content: 'Signature reads: Events Manager, Harbor Hotel, direct line 555-0142.', tags: t(HOTEL_JENNA, HOTEL), validFrom: '2026-10-20' },
  { key: 'jp-prefers', concept: 'Prefers email over calls', content: 'Prefers email to phone and answers within the business day.', tags: t(HOTEL_JENNA), validFrom: '2026-10-21' },
  { key: 'jp-parking', concept: 'Vendor parking passes', content: 'Two vendor parking passes will be left at the front desk.', tags: t(HOTEL_JENNA, GALA), validFrom: '2026-11-05' },
  // Jenna Liu, photographer
  { key: 'jl-quote', concept: 'Photography quote $900', content: 'Quoted $900 for four hours of coverage including edited images in two weeks.', tags: t(PHOTO_JENNA, MARKET), validFrom: '2026-10-15' },
  { key: 'jl-shotlist', concept: 'Shot list for the booth', content: 'Wants a shot list by Monday: booth setup, arrangements close-up, customers at the stall.', tags: t(PHOTO_JENNA, MARKET), validFrom: '2026-10-18' },
  { key: 'jl-portfolio', concept: 'Portfolio link sent', content: 'Sent her portfolio; mostly weddings and food markets, natural light style.', tags: t(PHOTO_JENNA), validFrom: '2026-10-10' },
  { key: 'jl-deposit', concept: 'Photography deposit paid', content: 'Paid the $300 booking deposit by card; balance due on the day.', tags: t(PHOTO_JENNA), validFrom: '2026-10-19' },
  { key: 'jl-rain', concept: 'Rain plan for the shoot', content: 'If it rains she will shoot under the covered arcade instead.', tags: t(PHOTO_JENNA, MARKET), validFrom: '2026-10-22' },
  // Leo Martinez, staff
  { key: 'leo-thursday', concept: 'Centerpiece prep on Thursday', content: 'Will prep the centerpieces Thursday because he is off on Friday.', tags: t(LEO, GALA), validFrom: '2026-11-03' },
  { key: 'leo-dayoff', concept: 'Day off request', content: 'Asked for Friday Nov 6 off for a family wedding.', tags: t(LEO), validFrom: '2026-11-01' },
  { key: 'leo-van', concept: 'Drives the van', content: 'Has the van keys and does all deliveries over ten miles.', tags: t(LEO), validFrom: '2026-09-30' },
  { key: 'leo-hours', concept: 'Part-time hours', content: 'Works Tuesday to Thursday, 8 to 3, paid weekly.', tags: t(LEO), validFrom: '2026-09-01' },
  { key: 'leo-allergy', concept: 'Lily pollen allergy', content: 'Allergic to lily pollen; gloves and a mask when handling them.', tags: t(LEO), validFrom: '2026-09-02' },
  // Priya Shah, florist supplier
  { key: 'pr-order', concept: 'Standing Tuesday order', content: 'The usual Tuesday order is 10 bunches of eucalyptus and 6 of white ranunculus.', tags: t(PRIYA, GREENSTEM), validFrom: '2026-10-01' },
  { key: 'pr-price', concept: 'Ranunculus price up', content: 'Price for ranunculus went up to $4.20 a stem from November.', tags: t(PRIYA, GREENSTEM), validFrom: '2026-10-28' },
  { key: 'pr-sub', concept: 'Peony substitute suggested', content: 'Suggested garden roses as a substitute while peonies are out of season.', tags: t(PRIYA, GALA), validFrom: '2026-10-30' },
  { key: 'pr-cutoff', concept: 'Order cutoff 3pm', content: 'Orders placed after 3pm ship the following day.', tags: t(PRIYA, GREENSTEM), validFrom: '2026-09-15' },
  { key: 'pr-invoice', concept: 'Invoice 7781 net 30', content: 'Invoice 7781 for October supplies is on net 30 terms.', tags: t(PRIYA, GREENSTEM), validFrom: '2026-11-01' },
  // Tom Becker, lawyer
  { key: 'tom-lease', concept: 'Shop lease renewal review', content: 'Reviewing the shop lease renewal; flagged the 5% escalator clause.', tags: t(TOM), validFrom: '2026-10-05' },
  { key: 'tom-fee', concept: 'Legal fee estimate', content: 'Estimated two hours at $250 an hour for the lease review.', tags: t(TOM), validFrom: '2026-10-06' },
  { key: 'tom-sign', concept: 'Lease signing appointment', content: 'Signing appointment booked for Nov 12 at 10am at his office.', tags: t(TOM), validFrom: '2026-11-02' },
  { key: 'tom-llc', concept: 'LLC annual report reminder', content: 'Reminded us the LLC annual report is due by the end of December.', tags: t(TOM), validFrom: '2026-10-25' },
  { key: 'tom-contract', concept: 'Vendor contract template', content: 'Sent a vendor contract template to reuse for event work.', tags: t(TOM, GALA), validFrom: '2026-10-26' },
  // Dana Cole, the bank
  { key: 'dana-loan', concept: 'Equipment loan pre-approved', content: 'Pre-approved for a $12,000 equipment loan for a second cooler.', tags: t(DANA), validFrom: '2026-10-12' },
  { key: 'dana-docs', concept: 'Loan documents needed', content: 'Needs last year\'s tax return and three months of statements before closing.', tags: t(DANA), validFrom: '2026-10-14' },
  { key: 'dana-rate', concept: 'Loan rate 7.4%', content: 'Quoted 7.4% fixed over five years.', tags: t(DANA), validFrom: '2026-10-13' },
  { key: 'dana-merchant', concept: 'Card reader fee change', content: 'Card processing fee drops to 2.6% from January.', tags: t(DANA), validFrom: '2026-11-03' },
  { key: 'dana-fraud', concept: 'Fraud warning about payment changes', content: 'Warned that vendors never change payment details by email alone; always call to confirm.', tags: t(DANA), validFrom: '2026-10-29' },
  // The hotel (organisation)
  { key: 'hotel-deposit', concept: 'Deposit invoice 1043', content: 'Deposit of $1,650 for the event décor, invoice 1043, due Nov 10.', tags: t(HOTEL, GALA), validFrom: '2026-10-28' },
  { key: 'hotel-address', concept: 'Venue address', content: 'Address: 1 Pier Street; the service entrance is on the north side.', tags: t(HOTEL), validFrom: '2026-10-20' },
  { key: 'hotel-insurance', concept: 'Vendor insurance certificate', content: 'Requires a certificate of insurance from every vendor a week before.', tags: t(HOTEL, GALA), validFrom: '2026-10-27' },
  { key: 'hotel-noflame', concept: 'No open flames', content: 'Only LED candles are allowed in the ballroom; no open flames.', tags: t(HOTEL, GALA), validFrom: '2026-10-30' },
  { key: 'hotel-paid', concept: 'Last year paid on time', content: 'Paid last year\'s invoice within ten days, good client.', tags: t(HOTEL), validFrom: '2025-12-01' },
  // Greenstem wholesale (organisation)
  { key: 'gs-hours', concept: 'Warehouse pickup hours', content: 'Pickup at the warehouse 6am to noon, weekdays only.', tags: t(GREENSTEM), validFrom: '2026-09-10' },
  { key: 'gs-account', concept: 'Trade account number', content: 'Trade account GS-2291, 10% discount over $500.', tags: t(GREENSTEM), validFrom: '2026-09-11' },
  { key: 'gs-holiday', concept: 'Thanksgiving closure', content: 'Closed Thanksgiving Thursday and Friday; order Wednesday by 3pm.', tags: t(GREENSTEM), validFrom: '2026-11-04' },
  { key: 'gs-delivery', concept: 'Delivery fee waived', content: 'Delivery fee waived for orders over $300.', tags: t(GREENSTEM), validFrom: '2026-10-02' },
  // The gala (situation)
  { key: 'gala-date', concept: 'Event date Nov 14', content: 'The event is Saturday Nov 14, doors at 6pm, 32 tables.', tags: t(GALA, HOTEL), validFrom: '2026-10-20' },
  { key: 'gala-theme', concept: 'Theme white and eucalyptus', content: 'Theme is white and eucalyptus with low arrangements so guests can see across the table.', tags: t(GALA), validFrom: '2026-10-22' },
  { key: 'gala-budget', concept: 'Décor budget $5,500', content: 'Total décor budget is $5,500 including the deposit.', tags: t(GALA), validFrom: '2026-10-23' },
  { key: 'gala-teardown', concept: 'Teardown by midnight', content: 'Everything must be out of the room by midnight.', tags: t(GALA, HOTEL), validFrom: '2026-10-31' },
  { key: 'gala-open', concept: 'Still open: final count and LEDs', content: 'Still open: final centerpiece count and ordering 40 LED candles.', tags: t(GALA), validFrom: '2026-11-05' },
  // The spring market (situation)
  { key: 'mk-fee', concept: 'Stall fee $180', content: 'Stall fee is $180 for the season, due by March 1.', tags: t(MARKET), validFrom: '2026-10-05' },
  { key: 'mk-spot', concept: 'Corner stall assigned', content: 'Assigned the corner stall by the fountain, number 14.', tags: t(MARKET), validFrom: '2026-10-08' },
  { key: 'mk-days', concept: 'Saturdays April to June', content: 'Runs Saturdays from April to June, 8am to 1pm.', tags: t(MARKET), validFrom: '2026-10-09' },
  { key: 'mk-permit', concept: 'Food permit not needed', content: 'Flowers only, so no food permit is required.', tags: t(MARKET), validFrom: '2026-10-11' },
  { key: 'mk-tent', concept: 'Tent weights required', content: 'Each tent leg needs a 25 lb weight.', tags: t(MARKET), validFrom: '2026-10-12' },
  // The look-alike sender: must never answer for the real hotel contact.
  { key: 'fake-bank', concept: 'New bank details for the deposit', content: 'Please wire the deposit to our new account at First Coastal, routing 021000021.', tags: t(FAKE_HOTEL), validFrom: '2026-11-06' },
  { key: 'fake-urgent', concept: 'Urgent payment request', content: 'Payment must be received today or the booking is released.', tags: t(FAKE_HOTEL), validFrom: '2026-11-06' },
  // Distractors: same vocabulary, no entity.
  { key: 'd1', concept: 'Confirm order counts on Fridays', content: 'Every Friday confirm the order counts for next week.', tags: [] },
  { key: 'd2', concept: 'Deposit policy', content: 'We ask clients for a 30% deposit to hold a date.', tags: [] },
  { key: 'd3', concept: 'Centerpiece pricing guide', content: 'Low centerpieces $45, tall $85, LED candles $3 each.', tags: [] },
  { key: 'd4', concept: 'Parking at the shop', content: 'Staff park behind the shop; customers use the street.', tags: [] },
  { key: 'd5', concept: 'Weekly payroll', content: 'Payroll runs every Friday through the bank portal.', tags: [] },
  { key: 'd6', concept: 'Photo policy', content: 'We photograph every arrangement before delivery for the portfolio.', tags: [] },
  { key: 'd7', concept: 'Insurance renewal', content: 'Business insurance renews in March; premium was $1,200.', tags: [] },
  { key: 'd8', concept: 'Lease basics', content: 'The shop lease runs to June with a two-year renewal option.', tags: [] },
  // Distractors for the broad questions: their generic wording, no entity.
  { key: 'g1', concept: 'Weekly update', content: "What's new this week: nothing going on beyond the usual orders.", tags: [] },
  { key: 'g2', concept: 'Where are we on things', content: 'Where we are on open items: see the whiteboard; the latest is posted Mondays.', tags: [] },
  { key: 'g3', concept: 'Remind me list', content: 'Remind me to water the window boxes and to update the price board.', tags: [] },
  { key: 'g4', concept: 'Notes on new customers', content: 'Notes on what to know about new customers: ask how they heard about us.', tags: [] },
  { key: 'g5', concept: 'Anything from the inbox', content: 'Check the inbox every morning for anything new from customers lately.', tags: [] },
  { key: 'g6', concept: 'What is happening this month', content: "What's happening this month: two weddings and the school fundraiser.", tags: [] },
  { key: 'g7', concept: 'Latest news', content: 'Latest news from the street association: the farmers market moves to Sundays next year.', tags: [] },
  { key: 'g8', concept: 'Any update on the van', content: 'Any update on the van service: booked for next Tuesday.', tags: [] },
];

// Questions. `lower` = refers to the entity only by a lowercase name or role.
type Q = { q: string; gold: string[]; entities: string[]; lower: boolean };
const QS: Q[] = [
  { q: 'what did jenna want us to confirm?', gold: ['jp-confirm'], entities: [HOTEL_JENNA], lower: true },
  { q: 'anything new from jenna about tables?', gold: ['jp-tablecount'], entities: [HOTEL_JENNA], lower: true },
  { q: 'how does jenna like to be contacted?', gold: ['jp-prefers'], entities: [HOTEL_JENNA], lower: true },
  { q: 'where do the parking passes from the events manager get picked up?', gold: ['jp-parking'], entities: [HOTEL_JENNA], lower: true },
  { q: 'what did jenna liu quote for photos?', gold: ['jl-quote'], entities: [PHOTO_JENNA], lower: true },
  { q: 'what does the photographer need by monday?', gold: ['jl-shotlist'], entities: [PHOTO_JENNA], lower: true },
  { q: 'what if it rains for the photographer?', gold: ['jl-rain'], entities: [PHOTO_JENNA], lower: true },
  { q: 'why is leo prepping on thursday?', gold: ['leo-thursday'], entities: [LEO], lower: true },
  { q: 'what is leo allergic to?', gold: ['leo-allergy'], entities: [LEO], lower: true },
  { q: 'what hours does leo work?', gold: ['leo-hours'], entities: [LEO], lower: true },
  { q: 'what is the usual order from priya?', gold: ['pr-order'], entities: [PRIYA], lower: true },
  { q: 'what did the florist suggest instead of peonies?', gold: ['pr-sub'], entities: [PRIYA], lower: true },
  { q: 'when is the signing with the lawyer?', gold: ['tom-sign'], entities: [TOM], lower: true },
  { q: 'what did tom flag in the lease?', gold: ['tom-lease'], entities: [TOM], lower: true },
  { q: 'what rate did the bank quote?', gold: ['dana-rate'], entities: [DANA], lower: true },
  { q: 'what papers does dana need?', gold: ['dana-docs'], entities: [DANA], lower: true },
  { q: 'what does the hotel require from vendors?', gold: ['hotel-insurance'], entities: [HOTEL], lower: true },
  { q: 'can we use real candles at the hotel?', gold: ['hotel-noflame'], entities: [HOTEL], lower: true },
  { q: 'when is the gala?', gold: ['gala-date'], entities: [GALA], lower: true },
  { q: "what's still open for the gala?", gold: ['gala-open'], entities: [GALA], lower: true },
  { q: 'what is the theme of the gala?', gold: ['gala-theme'], entities: [GALA], lower: true },
  { q: 'which stall did we get at the market?', gold: ['mk-spot'], entities: [MARKET], lower: true },
  { q: 'how much do tent weights need to be at the spring market?', gold: ['mk-tent'], entities: [MARKET], lower: true },
  { q: 'when does greenstem close for thanksgiving?', gold: ['gs-holiday'], entities: [GREENSTEM], lower: true },
  // Capitalised or fully written: the existing route already has a chance here.
  { q: 'What is the deposit on invoice 1043 for the Harbor Hotel?', gold: ['hotel-deposit'], entities: [HOTEL], lower: false },
  { q: 'What did Jenna Park say about load-in?', gold: ['jp-loadin'], entities: [HOTEL_JENNA], lower: false },
  { q: 'What is the Harbor Hotel address?', gold: ['hotel-address'], entities: [HOTEL], lower: false },
  { q: 'What deposit did we pay Jenna Liu?', gold: ['jl-deposit'], entities: [PHOTO_JENNA], lower: false },
  { q: 'Does Leo drive the van?', gold: ['leo-van'], entities: [LEO], lower: false },
  { q: 'What did Priya say about the ranunculus price?', gold: ['pr-price'], entities: [PRIYA], lower: false },
  { q: 'What is the Greenstem trade account?', gold: ['gs-account'], entities: [GREENSTEM], lower: false },
  { q: 'What did Tom Becker estimate for fees?', gold: ['tom-fee'], entities: [TOM], lower: false },
  { q: 'What did Dana warn about payment changes?', gold: ['dana-fraud'], entities: [DANA], lower: false },
  { q: 'What is the décor budget for the Harbor Hotel gala?', gold: ['gala-budget'], entities: [GALA, HOTEL], lower: false },
  { q: 'When is the Spring Market stall fee due?', gold: ['mk-fee'], entities: [MARKET], lower: false },
  { q: 'Did events@harborhotel.example ask about the centerpieces?', gold: ['jp-confirm'], entities: [HOTEL_JENNA], lower: false },
  // Questions that name nobody: the flag must inject nothing.
  { q: 'what is our deposit policy?', gold: ['d2'], entities: [], lower: false },
  { q: 'how much is a tall centerpiece?', gold: ['d3'], entities: [], lower: false },
  { q: 'when does business insurance renew?', gold: ['d7'], entities: [], lower: false },
  { q: 'when does payroll run?', gold: ['d5'], entities: [], lower: false },
];

// Broad questions: they name only the entity, the rest is generic. Any memory about the
// entity is a hit. This is MWA's failure shape: "anything new from jenna?" where her
// memories say "events manager" and "she", never "jenna".
const ofEntity = (e: string) => MEMS.filter(m => m.tags.includes(t(e)[0])).map(m => m.key);
const BROAD: Q[] = [
  ['anything new from jenna?', HOTEL_JENNA], ["what's the latest with the events manager?", HOTEL_JENNA],
  ["what's going on with jenna liu?", PHOTO_JENNA], ['anything from the photographer lately?', PHOTO_JENNA],
  ['remind me about leo', LEO], ['what do i know about priya?', PRIYA], ['what should i know about the florist?', PRIYA],
  ['any update from the lawyer?', TOM], ['notes on tom', TOM], ["what's happening with the bank?", DANA], ['what about dana?', DANA],
  ["what's going on with the hotel?", HOTEL], ['remind me about greenstem', GREENSTEM], ['anything about the wholesaler?', GREENSTEM],
  ['where are we on the gala?', GALA], ['update me on the market', MARKET],
].map(([q, e]) => ({ q, gold: ofEntity(e), entities: [e], lower: true }));

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'awm-entity-eval-'));
  const store = new EngramStore(join(dir, 'eval.db'));
  const activation = new ActivationEngine(store as any);
  const engines = { store, connectionEngine: new ConnectionEngine(store as any, activation) } as any;
  const idOf: Record<string, string> = {};
  try {
    for (const m of MEMS) {
      const r = await performWrite(engines, {
        agentId: AGENT, concept: m.concept, content: m.content, tags: m.tags, validFrom: m.validFrom,
        memoryClass: 'canonical', enableReinforcement: false, eventType: 'observation', surprise: 0.3, causalDepth: 0.3, resolutionEffort: 0.3,
      } as any);
      idOf[m.key] = r.engram.id;
    }
    for (const [a, e] of ALIASES) {
      const r = await registerAlias(store as any, AGENT, a, e);
      if (!r.ok) throw new Error(`alias ${a}: ${r.error}`);
    }

    type Arm = 'off' | 'on' | 'hint';
    const ARMS: Arm[] = ['off', 'on', 'hint'];
    const mk = () => ({ s1: 0, s5: 0, lat: [] as number[] });
    const arms: Record<Arm, ReturnType<typeof mk>> = { off: mk(), on: mk(), hint: mk() };
    const lowerArms: Record<Arm, ReturnType<typeof mk>> = { off: mk(), on: mk(), hint: mk() };
    let wrongInjected = 0, injectedTotal = 0, fakeInjected = 0;
    const trace: any[] = [];

    // Warm the models once so neither arm pays the cold load.
    await activation.activate({ agentId: AGENT, context: 'warm up', limit: 3, internal: true } as any);

    const broadArms: Record<Arm, ReturnType<typeof mk>> = { off: mk(), on: mk(), hint: mk() };
    const ALL = [...QS.map(x => ({ ...x, broad: false })), ...BROAD.map(x => ({ ...x, broad: true }))];
    for (const [qi, item] of ALL.entries()) {
      const golds = item.gold.map(k => idOf[k]);
      const row: any = { q: item.q, lower: item.lower, broad: item.broad };
      // Interleave: alternate which arm goes first.
      const order = ARMS.map((_, i) => ARMS[(i + qi) % ARMS.length]); // rotate which arm goes first
      for (const arm of order) {
        if (arm === 'off') delete process.env.AWM_ENTITY_ALIAS_MATCH; else process.env.AWM_ENTITY_ALIAS_MATCH = '1';
        if (arm === 'hint') process.env.AWM_ENTITY_ALIAS_PASSAGE = '1'; else delete process.env.AWM_ENTITY_ALIAS_PASSAGE;
        const t0 = process.hrtime.bigint();
        const res: any[] = await activation.activate({ agentId: AGENT, context: item.q, limit: 5, internal: true } as any);
        arms[arm].lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
        const rank = res.findIndex(r => golds.includes(r.engram.id));
        if (item.broad) {
          if (rank === 0) broadArms[arm].s1++;
          if (rank >= 0 && rank < 5) broadArms[arm].s5++;
        } else {
          if (rank === 0) { arms[arm].s1++; if (item.lower) lowerArms[arm].s1++; }
          if (rank >= 0 && rank < 5) { arms[arm].s5++; if (item.lower) lowerArms[arm].s5++; }
        }
        row[arm] = rank;
      }
      delete process.env.AWM_ENTITY_ALIAS_MATCH;
      delete process.env.AWM_ENTITY_ALIAS_PASSAGE;
      // What the flag injects for this question (the same computation activation.ts runs).
      const injected = selectEntityHits(await store.matchEntityTerms(entityQueryGrams(item.q), [AGENT]));
      injectedTotal += injected.length;
      const wrong = injected.filter(e => !item.entities.includes(e));
      wrongInjected += wrong.length;
      if (injected.includes(FAKE_HOTEL)) fakeInjected++;
      row.injected = injected;
      if (wrong.length) row.wrong = wrong;
      trace.push(row);
    }

    const n = QS.length, nl = QS.filter(q => q.lower).length, nb = BROAD.length;
    const r1 = (x: number, d: number) => Math.round((1000 * x) / d) / 10;
    const out = {
      date: new Date().toISOString(),
      memories: MEMS.length, aliases: ALIASES.length, questions: n, lowercaseQuestions: nl,
      broadQuestions: nb,
      broadOff: { success1: r1(broadArms.off.s1, nb), success5: r1(broadArms.off.s5, nb) },
      broadOn: { success1: r1(broadArms.on.s1, nb), success5: r1(broadArms.on.s5, nb) },
      broadHint: { success1: r1(broadArms.hint.s1, nb), success5: r1(broadArms.hint.s5, nb) },
      off: { success1: r1(arms.off.s1, n), success5: r1(arms.off.s5, n), lower1: r1(lowerArms.off.s1, nl), lower5: r1(lowerArms.off.s5, nl), p50ms: Math.round(pct(arms.off.lat, 0.5)), p95ms: Math.round(pct(arms.off.lat, 0.95)) },
      on: { success1: r1(arms.on.s1, n), success5: r1(arms.on.s5, n), lower1: r1(lowerArms.on.s1, nl), lower5: r1(lowerArms.on.s5, nl), p50ms: Math.round(pct(arms.on.lat, 0.5)), p95ms: Math.round(pct(arms.on.lat, 0.95)) },
      hint: { success1: r1(arms.hint.s1, n), success5: r1(arms.hint.s5, n), lower1: r1(lowerArms.hint.s1, nl), lower5: r1(lowerArms.hint.s5, nl), p50ms: Math.round(pct(arms.hint.lat, 0.5)), p95ms: Math.round(pct(arms.hint.lat, 0.95)) },
      injection: { entitiesInjected: injectedTotal, wrongEntities: wrongInjected, wrongRate: injectedTotal ? r1(wrongInjected, injectedTotal) : 0, lookalikeInjected: fakeInjected },
      trace,
    };
    const here = dirname(fileURLToPath(import.meta.url));
    writeFileSync(join(here, 'results.json'), JSON.stringify(out, null, 2));
    const { trace: _t, ...summary } = out;
    console.log(JSON.stringify(summary, null, 2));
    for (const r of trace) if (r.off !== r.on || r.off !== r.hint || r.wrong) console.log(`  off=${r.off} on=${r.on} hint=${r.hint}${r.wrong ? ' WRONG=' + r.wrong.join(',') : ''}  ${r.broad ? '[broad] ' : ''}${r.q}`);
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
