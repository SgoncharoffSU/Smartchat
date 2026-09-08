-- CreateEnum
CREATE TYPE "TestScenarioMode" AS ENUM ('simulated', 'replay');

-- CreateEnum
CREATE TYPE "TestVerdict" AS ENUM ('pass', 'issue', 'critical');

-- CreateTable
CREATE TABLE "test_scenarios" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" "TestScenarioMode" NOT NULL DEFAULT 'simulated',
    "customer_brief" TEXT,
    "replay_messages" JSONB,
    "source_dialog_id" TEXT,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_runs" (
    "id" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "test_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "scenario_id" TEXT NOT NULL,
    "transcript" JSONB NOT NULL,
    "verdict" "TestVerdict" NOT NULL,
    "what_was_wrong" TEXT,
    "expected_answer" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "test_scenarios_bot_id_idx" ON "test_scenarios"("bot_id");

-- CreateIndex
CREATE INDEX "test_runs_bot_id_idx" ON "test_runs"("bot_id");

-- CreateIndex
CREATE INDEX "test_results_run_id_idx" ON "test_results"("run_id");

-- CreateIndex
CREATE INDEX "test_results_scenario_id_idx" ON "test_results"("scenario_id");

-- AddForeignKey
ALTER TABLE "test_scenarios" ADD CONSTRAINT "test_scenarios_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_bot_id_fkey" FOREIGN KEY ("bot_id") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "test_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "test_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
