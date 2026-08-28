-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "enables_provisioning" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "funnel_generated_at" TIMESTAMP(3),
ADD COLUMN     "source_website" TEXT;

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "registered_at" TIMESTAMP(3),
ADD COLUMN     "registration_token" TEXT,
ADD COLUMN     "trial_ends_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "companies_registration_token_key" ON "companies"("registration_token");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

