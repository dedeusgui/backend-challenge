# Local load baseline

> English reference copy. The Portuguese main version is [LOAD_TEST_BASELINE.md](LOAD_TEST_BASELINE.md).
> Methodology and criteria for each step are in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md), the automatically generated
> report of the measurement made in the cloud. This page measures the same suite on another machine, with 13 scenarios.

## What this baseline is and is not

- **It is** a reproducible measurement: the environment, method, limits, and raw records are kept in the repository, and the table comes
  from a command. It serves to compare scenarios (number of APIs, CPUs, and workers) on the same machine.
- **It is not** a target for requests per second. The prompt does not define an RPS target and evaluates the quality of the
  experiment and the honesty of the analysis (section 14 of [CHALLENGE.md](CHALLENGE.md)).
- **It is not** a comparison of improvement. The local machine and the cloud machine are different, as the environment table shows.

## Environment

| Item       | Local (this baseline)                            | Cloud ([LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md)) |
| ---------- | ------------------------------------------------ | ---------------------------------------------------- |
| Processor  | AMD Ryzen 7 7735HS, 8 cores and 16 threads (SMT) | Intel Xeon @ 2.10 GHz, 4 vCPUs                       |
| Memory     | 22 GiB                                           | 15.7 GiB                                             |
| System     | Linux 7.2.6                                      | Linux 6.18.44                                        |
| Bun        | 1.4.4                                            | 1.4.4                                                |
| Docker     | 29.9.2                                           | not recorded in the report                           |
| PostgreSQL | 17 (`postgres:17-alpine`), default configuration | 17, default configuration                            |
| LocalStack | 4.14.0, SQS                                      | 4.14, SQS                                            |

On the local machine, CPUs `n` and `n+1` (with `n` even) are threads of the same core. Therefore, a 2 CPU
stack occupies one whole core, and a 1 CPU stack shares the core with the generator.

## How to reproduce

```text
bun run infra:up
LOAD_CPUS=2 LOAD_API_PROCESSES=1 LOAD_WORKER_PROCESSES=2 \
  LOAD_RATES=10,25,50,75,100,125,150,200,300,400,500,600,800,1000,1200,1500 \
  LOAD_RESULTS_DIR=docs/load/local/apis1-workers2-cpus2 \
  LOAD_REPORT_PATH="$(mktemp)" \
  bun run test:load
bun run load:consolidate docs/load/local
```

- `LOAD_CPUS` is the number of CPUs in the stack. `LOAD_API_PROCESSES` and `LOAD_WORKER_PROCESSES` change the topology, and the
  default is the agreed one (3 APIs and 2 workers).
- `LOAD_RATES` is the ramp. The harness default stops at 400 req/s, and that is not enough for 8 CPUs; therefore the matrix
  used the list above.
- Without `LOAD_RESULTS_DIR` and `LOAD_REPORT_PATH`, the run writes to `docs/load/results/` and to
  `docs/LOAD_TEST_RESULTS.md`, which are the cloud results. Point both to another location.
- The scenario name follows `apis<A>-workers<W>-cpus<N>`. Each directory in `docs/load/local/` has a `cpus-<N>.json`,
  the raw record of the run.

## Results

Each row is one run, with the entire ramp. The headers come from the consolidator (`test/load/consolidate.ts`) and
are intentionally in English, to remain the same as in the cloud report.

| Scenario             | APIs | Workers | Stack CPUs | Agreed (req/s) | Per stack CPU (req/s) | CPU µs/req | Utilisation | API CPU % | Worker CPU % | PostgreSQL % | LocalStack % | Largest process RSS (MiB) | First failing (req/s) | Why it failed                                     |
| -------------------- | ---: | ------: | ---------: | -------------: | --------------------: | ---------: | ----------: | --------: | -----------: | -----------: | -----------: | ------------------------: | --------------------: | ------------------------------------------------- |
| apis1-workers2-cpus1 |    1 |       2 |          1 |            150 |                 150.0 |       4754 |         71% |        35 |            4 |           26 |            7 |                       287 |                   200 | p95 1887.8 ms (max 500); p99 1940.9 ms (max 1000) |
| apis1-workers2-cpus2 |    1 |       2 |          2 |            300 |                 150.0 |       5301 |         79% |        69 |            9 |           64 |           16 |                       325 |                   400 | p95 4437.0 ms (max 500); p99 4598.0 ms (max 1000) |
| apis1-workers2-cpus4 |    1 |       2 |          4 |            400 |                 100.0 |       5242 |         52% |        86 |           15 |           85 |           24 |                       288 |                   500 | p95 2448.5 ms (max 500); p99 2520.0 ms (max 1000) |
| apis1-workers2-cpus8 |    1 |       2 |          8 |            500 |                  62.5 |       4713 |         29% |        94 |           15 |          102 |           25 |                       312 |                   600 | p95 1965.3 ms (max 500); p99 1989.3 ms (max 1000) |
| apis2-workers2-cpus1 |    2 |       2 |          1 |            150 |                 150.0 |       5556 |         83% |        43 |            4 |           29 |            7 |                       257 |                   200 | p95 4789.1 ms (max 500); p99 4974.4 ms (max 1000) |
| apis2-workers2-cpus2 |    2 |       2 |          2 |            300 |                 150.0 |       6164 |         92% |        88 |            9 |           70 |           16 |                       291 |                   400 | p95 7419.4 ms (max 500); p99 7824.9 ms (max 1000) |
| apis2-workers2-cpus4 |    2 |       2 |          4 |            500 |                 125.0 |       6237 |         78% |       137 |           18 |          127 |           30 |                       273 |                   600 | p95 1365.9 ms (max 500); p99 1411.3 ms (max 1000) |
| apis2-workers2-cpus8 |    2 |       2 |          8 |            600 |                  75.0 |       5472 |         41% |       147 |           18 |          130 |           34 |                       267 |                   800 | p95 1326.2 ms (max 500); p99 1405.9 ms (max 1000) |
| apis3-workers1-cpus2 |    3 |       1 |          2 |            200 |                 100.0 |       6590 |         66% |        67 |            6 |           48 |           10 |                       223 |                   300 | p95 1083.5 ms (max 500); p99 1904.3 ms (max 1000) |
| apis3-workers2-cpus1 |    3 |       2 |          1 |            125 |                 125.0 |       6557 |         81% |        45 |            4 |           26 |            6 |                       176 |                   150 | p95 600.3 ms (max 500); p99 1348.7 ms (max 1000)  |
| apis3-workers2-cpus2 |    3 |       2 |          2 |            200 |                 100.0 |       6764 |         68% |        68 |            6 |           49 |           11 |                       260 |                   300 | p95 4415.7 ms (max 500); p99 4651.5 ms (max 1000) |
| apis3-workers2-cpus4 |    3 |       2 |          4 |            500 |                 125.0 |       6742 |         84% |       162 |           17 |          130 |           29 |                       264 |                   600 | p95 2488.8 ms (max 500); p99 2626.1 ms (max 1000) |
| apis3-workers2-cpus8 |    3 |       2 |          8 |            800 |                 100.0 |       6422 |         63% |       237 |           25 |          197 |           44 |                       276 |                  1000 | p95 8963.9 ms (max 500); p99 9299.4 ms (max 1000) |

Legend:

- **Agreed:** the highest rate of the last step that passed all the constraints in [LOAD_TEST_RESULTS.md](LOAD_TEST_RESULTS.md),
  with 20 s steps. The ramp stops at the first step that fails.
- **CPU µs/req:** stack CPU above idle, divided by the requests answered, in the agreed step.
- **Utilisation:** net stack CPU divided by the CPUs assigned to it.
- **API, Worker, PostgreSQL, LocalStack %:** net CPU of each group in the agreed step. 100 is one whole core.
  With multiple APIs, the value is the sum of the processes.
- **Largest process RSS:** highest RSS of a process across all steps of the run, sampled every 500 ms. It is a
  floor for the actual peak.
- **First failing and Why it failed:** the first step that broke a constraint, with the reason.

### Correctness, latency and concurrency at the agreed step

Same scenarios, at each one's agreed step. The headers follow the consolidator, which is in English.

| Scenario             | Error rate (%) | Lost | 5xx | Violations | Duplicates | Incorrect answers | Concurrency conflicts (whole run) | Lock waiters mean / max | Outbox drain (s) | Events created | p50 (ms) | p95 (ms) | p99 (ms) | Generator lag p99 (ms) |
| -------------------- | -------------: | ---: | --: | ---------: | ---------: | ----------------: | --------------------------------: | ----------------------: | ---------------: | -------------: | -------: | -------: | -------: | ---------------------: |
| apis1-workers2-cpus1 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.1 / 1 |              0.0 |           4461 |      8.2 |     93.5 |    145.8 |                    1.1 |
| apis1-workers2-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.5 / 4 |              0.0 |           8933 |     20.7 |    165.7 |    245.1 |                    1.2 |
| apis1-workers2-cpus4 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.2 / 3 |              0.0 |          12092 |      9.2 |     25.3 |     49.6 |                    1.3 |
| apis1-workers2-cpus8 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 5 |              0.0 |          14939 |      8.2 |     74.4 |    109.3 |                    1.1 |
| apis2-workers2-cpus1 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 4 |              0.0 |           4457 |     23.7 |    117.0 |    160.8 |                    1.1 |
| apis2-workers2-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                5.1 / 11 |              0.2 |           8945 |     72.6 |    328.6 |    538.7 |                    1.6 |
| apis2-workers2-cpus4 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.5 / 7 |              0.0 |          15042 |     11.5 |     40.1 |     74.3 |                    1.1 |
| apis2-workers2-cpus8 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 6 |              0.0 |          18080 |      7.4 |     17.5 |     64.8 |                    1.3 |
| apis3-workers1-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                 0.3 / 7 |              0.0 |           6020 |      7.7 |    103.8 |    307.5 |                    1.5 |
| apis3-workers2-cpus1 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                1.8 / 12 |              0.0 |           3770 |     31.3 |    341.7 |    658.8 |                    1.2 |
| apis3-workers2-cpus2 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                0.7 / 14 |              0.0 |           5940 |      8.9 |    135.8 |    339.1 |                    1.8 |
| apis3-workers2-cpus4 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                6.7 / 22 |              0.0 |          14873 |     17.3 |    391.6 |    602.7 |                    1.1 |
| apis3-workers2-cpus8 |          0.000 |    0 |   0 |          0 |          0 |                 0 |                                 0 |                6.0 / 22 |              0.0 |          23898 |     11.3 |    277.0 |    602.7 |                    1.4 |

Legend for this table:

- **Error rate:** lost requests or 5xx answers, over the requests sent, at the agreed step.
- **Violations and Duplicates:** balance and ledger violations, and duplicates by provider and external id or by
  idempotency key, checked after the step.
- **Incorrect answers:** answers the contract does not allow for the request that received them.
- **Concurrency conflicts (whole run):** version conflicts counted by `concurrency_conflicts_total`, over the whole run.
- **Lock waiters mean / max:** PostgreSQL sessions waiting for a lock, sampled every 200 ms at the agreed step.
- **Outbox drain (s):** time until the outbox drained after the step. The limit is 60 s.
- **p50, p95, p99 (ms):** latency of answered requests, measured from the scheduled send time.
- **Generator lag p99 (ms):** lag of the generator behind its schedule. Above 50 ms, the step fails.

## Reading the results

- **One API alone approaches one whole core.** With 1 API and 8 CPUs, the API process uses 94% of one core
  in the agreed step of 500 req/s, and the entire stack uses only 29% of the assigned CPUs. Between 4 and 8 CPUs, the agreed rate rises from 400 to
  500 req/s. This is consistent with the single-threaded Node/Bun process being the limit.
- **More APIs help when there is spare CPU, and hinder when CPU is scarce.** With 4 CPUs, 2 or 3 APIs reach 500
  req/s, compared with 400 for 1 API. With 1 and with 2 CPUs, 3 APIs are below 1 API (125 and 200, compared with 150 and 300).
- **With 3 APIs and 8 CPUs, the stack reaches 800 req/s**, with each API near 79% of one core (237% combined). It is the
  highest agreed rate in this baseline. With 2 APIs on 8 CPUs, each API is near 73%, and the agreed rate is 600.
- **One or two workers did not change the agreed rate with 2 CPUs and 3 APIs.** Both are at 200 req/s, and fail at 300. This
  reading comes from one run per side, and says nothing about other configurations.
- **The failure is abrupt.** In the agreed step, p99 was between 50 and 660 ms. At the first failing step, p95 ranges from
  600 ms to 9 s, and p99 from 1.3 s to 9.3 s. The reasons are recorded in the last column.
- **Nonlinear in the scenario with 3 APIs and 1 CPU.** p99 was 851 ms at 100 req/s and 659 ms at 125 req/s, and 75
  req/s was 56 ms. This may be noise or contention on the same CPU. This run does not distinguish between the two hypotheses.
- **Local CPU per request is between 4713 and 6764 µs.** In the cloud, the same scenarios with 3 APIs are between 6764 and
  8320 µs. The difference is due to the machine, and there is no evidence of application improvement. See the comparison section.
- **Correctness at the agreed step.** In all 13 runs, the error rate was 0.000%, with no losses, no 5xx, no violations, no
  duplicates and no incorrect answers. The generator lag stayed between 1.1 and 1.8 ms (p99), so the generator did not limit
  the agreed steps. The steps passed the latency constraints: p95 up to 500 ms and p99 up to 1000 ms.
- **Concurrency: zero version conflicts, with lock waits.** The conflict counter was zero in all 13 runs. This is what the
  design predicts: the wallet read takes `PESSIMISTIC_WRITE`, and the version check fires only if the lock fails. The
  contention shows up as lock waits: on average up to 6.7 sessions and at the peak 22, in the 3-API runs with 4 and 8 CPUs.
  Waits are not separated by wallet, so they cannot be attributed to the hot wallet.
- **Outbox drain.** It was 0.0 s in 12 runs and 0.2 s in one (2 APIs, 2 CPUs), within the 60 s limit.

## Limitations

- **One run per scenario.** There is no confidence interval. A scenario may move from one side of a constraint to the other in another
  run, and a 20 s step proves only the 20 s it ran.
- **Logical CPU is not a core.** With 2, 4, and 8 CPUs, the stack occupies whole cores. With 1 CPU, the generator may run on the
  sibling thread of the stack, and that may weigh against the 1 CPU result.
- **The generator is a single process,** running on the CPUs left over. The generator lag constraint (p99 of 50 ms) is
  part of each step's approval. A lag failure appears in the "Why it failed" column.
- **Memory is sampled.** Sampling the peak every 500 ms may miss a brief peak.
- **LocalStack is not AWS SQS,** and PostgreSQL runs with the default configuration, without a replica or tuning.
- **Only the HTTP path.** The load mix goes through the API; the path through the command queue is covered by the concurrency tests,
  and is not included in this measurement.

## Harness changes for this measurement

- `LOAD_API_PROCESSES` and `LOAD_WORKER_PROCESSES` change the topology. The default remains 3 APIs and 2 workers.
- The recorded affinity of each process is now read at the end of the run. Previously, it was read right after spawning the
  workers, before `taskset` ran, and recorded the generator's affinity (for example `1-15`). The correction does not
  change the measurement, only the record. I did not check whether the cloud record for `worker-1` with 1 CPU (`1-3`) has the same
  cause.
- The report's limitations sentence no longer mentions fixed 3 APIs and 2 workers.
- The `bun run load:consolidate` consolidator generates this page's table. Validated against the published cloud records: it
  reproduces 100, 200, and 400 req/s, 8320, 7234, and 6764 µs per request, the same first failures, and the same reasons.
- The largest RSS column was added to the consolidated output.

## Side-by-side comparison with the cloud

Same topology (3 APIs, 2 workers), different machines. This is not a measure of improvement.

| Stack CPUs |                 Cloud: agreed (req/s) | Local: agreed (req/s) | Cloud: CPU µs/req | Local: CPU µs/req |
| ---------: | ------------------------------------: | --------------------: | ----------------: | ----------------: |
|          1 |                                   100 |                   125 |              8320 |              6557 |
|          2 |                                   200 |                   200 |              7234 |              6764 |
|          4 | 400 (top of the ramp, no limit found) |                   500 |              6764 |              6742 |

In the cloud, 4 CPUs reached the top of the default ramp (400 req/s) without failing, so the agreed rate of 400 is a floor, not the
limit. Here, the 4 CPU limit was 500, with failure at 600.

## Files

- `docs/load/local/<scenario>/cpus-<N>.json`: the 13 raw records for this baseline.
- `test/load/consolidate.ts` and the `load:consolidate` script in `package.json`: generate the table.
- `docs/LOAD_TEST_RESULTS.md` and `docs/load/results/`: cloud results, unchanged in this round.
