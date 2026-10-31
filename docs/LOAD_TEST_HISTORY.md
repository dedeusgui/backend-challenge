# Load test history

> **Read this first: runs 0 to 6 are superseded.** They were made with a driver that started `ps` and
> `docker stats` from inside the load generator's own loop, every 500 ms and on every reading. Those
> process starts delayed the generator, and the delay went into the latency. On the same stack at
> 50 req/s, the first driver measured a p99 of 478 ms and the one that starts no process during a step
> measured 48 ms, with the generator's lag p99 going from 44 ms to 1.9 ms (`DECISIONS.md`, N-16). So the
> latencies below are pessimistic, and so is the agreed figure of 150 req/s that was drawn from them. The
> pinned runs in `LOAD_TEST_RESULTS.md` replace them. The runs stay here as the record of what was
> measured, and of why the driver changed.

The pinned runs that replace these are in `docs/LOAD_TEST_RESULTS.md`, with one record per CPU count in
`docs/load/results/`. The first 4-CPU record was replaced by its rerun, because the first driver did not
raise the generator's in-flight limit when the generator had no CPUs of its own.

`docs/LOAD_TEST_RESULTS.md` is written again by every run, so it holds only the last one. This
file keeps the others. The numbers were copied from the run logs. Every run is on the same machine,
a 4-vCPU cloud VM with 15.7 GiB of memory, with all components on it: three API processes, two
workers, PostgreSQL 17, LocalStack 4.14 and the load driver.

## Agreed figure

**150 requests per second sustained.** Every run that reached 150 passed it with no loss and no error.
200 is the observed ceiling: it passed in four of the six runs, and its p99 ranged from 156 ms to 555 ms.
Run 5 lost one request at 200. Run 3 stopped at 100, on the old lag constraint. 300 failed in every run
that reached it, on p95 and p99 at 3 to 5 seconds.

We agree 150 because it held in every run, with margin. A figure from a single run would not survive
a second one.

## Runs

| Run | Driver version                                      | Agreed rate           | p99 at 200 req/s | 300 req/s                            | Lost (all steps)                   | Note                                                                                    |
| --- | --------------------------------------------------- | --------------------- | ---------------- | ------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------- |
| 0   | closed loop: 64 lanes, each waits for its answer    | not an open-model run | not measured     | not measured                         | 0 of 4000                          | The first version. It hides the queue, so it is not compared with the rest (N-01).      |
| 1   | open model, constraint on the maximum generator lag | 200                   | 235 ms           | fail: p95 5.2 s, generator lag 60 ms | 0                                  | First open-model ramp.                                                                  |
| 2   | open model, same constraints                        | 200                   | 156 ms           | fail: p95 3.1 s                      | 0                                  | Repeat of run 1.                                                                        |
| 3   | open model, same constraints                        | 50                    | 56 ms (at 100)   | not reached                          | 0                                  | 100 req/s failed on one lag sample of 53 ms. This made the lag constraint a p99 (N-02). |
| 4   | open model, constraint on the p99 of lag            | 200                   | 232 ms           | fail: p95 3.7 s                      | 0                                  | First run with the final lag constraint.                                                |
| 5   | as 4, plus CPU per component and container CPU      | 150                   | 157 ms           | not reached                          | 1 at 200 req/s, error not recorded | The loss was classified in run 6, but not in this one.                                  |
| 6   | as 5, plus the error name for each lost request     | 200                   | 555 ms           | fail: p95 5.2 s, p99 5.3 s           | 0                                  | The latest report, in `LOAD_TEST_RESULTS.md`.                                           |

## What the runs show

- **The knee is between 200 and 300 requests per second on this machine.** The failure at 300 is on
  latency, not on errors: no run at 300 lost a request.
- **At 300 req/s, the latency rises for every wallet, not only the hot one.** In run 6 the distinct-wallet
  p99 was 3,953 ms and the hot-wallet p99 4,782 ms.
- **The CPU does not explain 300.** In run 6 each API process used 43% of one CPU, PostgreSQL used
  101% (one core), LocalStack 43%, and the machine as a whole about 77%. The likely limit is PostgreSQL,
  under the hot-row lock and the default pool of 10 connections per process. This is an inference. The
  run did not measure lock waits or pool waits, so it is not proven.
- **The loss at 200 req/s in run 5 was a single request.** Its error was not recorded. In run 6 the
  same step lost nothing. A lost request is a constraint violation (N-04), and it is also a sign of a
  client or socket problem, not necessarily of the system. Recording the error is the way to tell them
  apart.
- **The variance between runs is large at the top of the range.** The p99 at 200 req/s ranged from 156 to
  555 ms. A run decides nothing alone. This is why the agreed figure is the rate that held in every run.

## For the interview machine

Run `bun run test:load` on that machine, and keep its `LOAD_TEST_RESULTS.md` with its environment
table. The same ramp, the same constraints and the same method then give a number that is comparable
with this one. The numbers from this cloud machine must not be quoted for another machine.
