-- CreateTable
CREATE TABLE "LaunchSubscriber" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'landing_page',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LaunchSubscriber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LaunchSubscriber_email_key" ON "LaunchSubscriber"("email");

-- CreateIndex
CREATE INDEX "LaunchSubscriber_createdAt_idx" ON "LaunchSubscriber"("createdAt");
