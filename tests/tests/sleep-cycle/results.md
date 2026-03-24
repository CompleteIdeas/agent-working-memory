# Sleep Cycle Test — 2026-03-24T14:43:26.602Z

## Summary
| Phase | Single-Topic | Cross-Topic | Noise | Overall |
|-------|-------------|-------------|-------|---------|
| Before Sleep #1 | 5/6 | 5/6 | 2/2 | 85.7% |
| After Sleep #1 | 5/6 | 4/6 | 2/2 | 78.6% |
| Before Sleep #2 | 5/6 | 3/6 | 2/2 | 71.4% |
| After Sleep #2 | 5/6 | 3/6 | 2/2 | 71.4% |
| After Sleep #3 | 5/6 | 3/6 | 2/2 | 71.4% |

## Sleep Cycle Stats
| Cycle | Clusters | Strengthened | Created | Decayed | Pruned |
|-------|----------|-------------|---------|---------|--------|
| #1 | 1 | 0 | 1 | 30 | 3 |
| #2 | 4 | 5 | 1 | 170 | 656 |
| #3 | 4 | 5 | 1 | 0 | 1006 |

## Cross-Topic Improvement
- Before sleep: 3/6
- After sleep #2: 3/6 (+0)
- After sleep #3: 3/6 (+0)

## Detailed Results
### Before Sleep #1
- [PASS] [single-topic] How long do JWT access tokens last? (2601ms)
- [PASS] [single-topic] What connection pooler is used for PostgreSQL? (2903ms)
- [PASS] [single-topic] How much does a horse transfer cost? (1797ms)
- [FAIL] [single-topic] What platform fee percentage does Stripe Connect charge? (3125ms)
- [PASS] [single-topic] What are the horse registration levels from lowest to highest? (2567ms)
- [PASS] [single-topic] What transaction isolation level is used for payment processing? (2460ms)
- [PASS] [cross-topic] What security measures protect payment processing from replay attacks? (2255ms)
- [PASS] [cross-topic] How does the authentication system prevent brute force and token theft? (3195ms)
- [FAIL] [cross-topic] What compliance checks are required before a horse can compete at Training level? (3022ms)
- [PASS] [cross-topic] How are organizer finances tracked from payment to payout? (3255ms)
- [PASS] [cross-topic] What database features ensure data integrity for concurrent financial operations? (3093ms)
- [PASS] [cross-topic] What audit and logging exists across authentication and payment events? (3888ms)
- [PASS] [noise] What color is the office building? (3623ms)
- [PASS] [noise] What was discussed at the team lunch? (3346ms)

### After Sleep #1
- [PASS] [single-topic] How long do JWT access tokens last? (3682ms)
- [PASS] [single-topic] What connection pooler is used for PostgreSQL? (4432ms)
- [PASS] [single-topic] How much does a horse transfer cost? (3818ms)
- [FAIL] [single-topic] What platform fee percentage does Stripe Connect charge? (3757ms)
- [PASS] [single-topic] What are the horse registration levels from lowest to highest? (3435ms)
- [PASS] [single-topic] What transaction isolation level is used for payment processing? (4119ms)
- [FAIL] [cross-topic] What security measures protect payment processing from replay attacks? (3832ms)
- [PASS] [cross-topic] How does the authentication system prevent brute force and token theft? (3935ms)
- [FAIL] [cross-topic] What compliance checks are required before a horse can compete at Training level? (4136ms)
- [PASS] [cross-topic] How are organizer finances tracked from payment to payout? (3387ms)
- [PASS] [cross-topic] What database features ensure data integrity for concurrent financial operations? (3718ms)
- [PASS] [cross-topic] What audit and logging exists across authentication and payment events? (3348ms)
- [PASS] [noise] What color is the office building? (4162ms)
- [PASS] [noise] What was discussed at the team lunch? (2666ms)

### Before Sleep #2
- [PASS] [single-topic] How long do JWT access tokens last? (1636ms)
- [PASS] [single-topic] What connection pooler is used for PostgreSQL? (2176ms)
- [PASS] [single-topic] How much does a horse transfer cost? (1301ms)
- [FAIL] [single-topic] What platform fee percentage does Stripe Connect charge? (1510ms)
- [PASS] [single-topic] What are the horse registration levels from lowest to highest? (1462ms)
- [PASS] [single-topic] What transaction isolation level is used for payment processing? (1444ms)
- [FAIL] [cross-topic] What security measures protect payment processing from replay attacks? (1474ms)
- [PASS] [cross-topic] How does the authentication system prevent brute force and token theft? (1509ms)
- [FAIL] [cross-topic] What compliance checks are required before a horse can compete at Training level? (2087ms)
- [PASS] [cross-topic] How are organizer finances tracked from payment to payout? (1620ms)
- [FAIL] [cross-topic] What database features ensure data integrity for concurrent financial operations? (1409ms)
- [PASS] [cross-topic] What audit and logging exists across authentication and payment events? (2262ms)
- [PASS] [noise] What color is the office building? (1746ms)
- [PASS] [noise] What was discussed at the team lunch? (1578ms)

### After Sleep #2
- [PASS] [single-topic] How long do JWT access tokens last? (1665ms)
- [PASS] [single-topic] What connection pooler is used for PostgreSQL? (2044ms)
- [PASS] [single-topic] How much does a horse transfer cost? (1176ms)
- [FAIL] [single-topic] What platform fee percentage does Stripe Connect charge? (1359ms)
- [PASS] [single-topic] What are the horse registration levels from lowest to highest? (1233ms)
- [PASS] [single-topic] What transaction isolation level is used for payment processing? (1351ms)
- [FAIL] [cross-topic] What security measures protect payment processing from replay attacks? (1203ms)
- [PASS] [cross-topic] How does the authentication system prevent brute force and token theft? (1837ms)
- [FAIL] [cross-topic] What compliance checks are required before a horse can compete at Training level? (1529ms)
- [PASS] [cross-topic] How are organizer finances tracked from payment to payout? (1558ms)
- [FAIL] [cross-topic] What database features ensure data integrity for concurrent financial operations? (2027ms)
- [PASS] [cross-topic] What audit and logging exists across authentication and payment events? (2029ms)
- [PASS] [noise] What color is the office building? (2001ms)
- [PASS] [noise] What was discussed at the team lunch? (1871ms)

### After Sleep #3
- [PASS] [single-topic] How long do JWT access tokens last? (1984ms)
- [PASS] [single-topic] What connection pooler is used for PostgreSQL? (2342ms)
- [PASS] [single-topic] How much does a horse transfer cost? (1614ms)
- [FAIL] [single-topic] What platform fee percentage does Stripe Connect charge? (2026ms)
- [PASS] [single-topic] What are the horse registration levels from lowest to highest? (1556ms)
- [PASS] [single-topic] What transaction isolation level is used for payment processing? (2002ms)
- [FAIL] [cross-topic] What security measures protect payment processing from replay attacks? (1747ms)
- [PASS] [cross-topic] How does the authentication system prevent brute force and token theft? (1984ms)
- [FAIL] [cross-topic] What compliance checks are required before a horse can compete at Training level? (2243ms)
- [PASS] [cross-topic] How are organizer finances tracked from payment to payout? (1656ms)
- [FAIL] [cross-topic] What database features ensure data integrity for concurrent financial operations? (2138ms)
- [PASS] [cross-topic] What audit and logging exists across authentication and payment events? (2151ms)
- [PASS] [noise] What color is the office building? (1970ms)
- [PASS] [noise] What was discussed at the team lunch? (2039ms)
