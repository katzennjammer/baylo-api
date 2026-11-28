-- System-calculated value brackets (28 Nov 2026). The owner lifted the schema
-- freeze after the defense; this adds ONE table and changes how Item.bracket
-- is kept, so the database is 29 tables + 1 view after it.
--
-- WHAT CHANGES
--   1. "BracketScheme": every bracket table the system has used or proposed.
--      Exactly one row is ACTIVE (a partial unique index enforces it).
--   2. Seeded with the hand-set table used until now, ACTIVE, so applying this
--      migration changes NO listing's bracket.
--   3. Item.bracket stops being a GENERATED column (its CASE was fixed at DDL
--      time, so new limits needed a migration). It becomes a plain column set
--      by a trigger from the ACTIVE row; activating a new scheme re-brackets
--      every row in the same transaction (activateBracketScheme() in
--      @/lib/bracket-scheme).
--
-- The functions pin search_path to the schema this migration runs in (SET
-- search_path FROM CURRENT), so a scratch copy's trigger reads its own table.
-- Safe to apply before the code: the old code never writes Item.bracket and
-- reads the same values.

CREATE TABLE "BracketScheme" (
  "id"          TEXT         NOT NULL,
  "ceilings"    INTEGER[]    NOT NULL,
  "method"      TEXT         NOT NULL,
  "status"      TEXT         NOT NULL DEFAULT 'PROPOSED',
  "sampleSize"  INTEGER      NOT NULL DEFAULT 0,
  "stats"       JSONB,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedAt" TIMESTAMP(3),
  "retiredAt"   TIMESTAMP(3),
  CONSTRAINT "BracketScheme_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BracketScheme_status_check" CHECK ("status" IN ('ACTIVE', 'PROPOSED', 'RETIRED')),
  CONSTRAINT "BracketScheme_ceilings_check" CHECK (array_length("ceilings", 1) = 9)
);
CREATE UNIQUE INDEX "BracketScheme_one_active" ON "BracketScheme"("status") WHERE "status" = 'ACTIVE';
CREATE INDEX "BracketScheme_createdAt_idx" ON "BracketScheme"("createdAt");

INSERT INTO "BracketScheme" ("id", "ceilings", "method", "status", "sampleSize", "stats", "activatedAt")
VALUES ('scheme-hand-set-2026-10', ARRAY[100,250,500,900,1500,2500,4000,9000,12000], 'hand-set', 'ACTIVE', 0,
        '{"note":"The hand-set table used from the schema v2 cutover (Oct 2026) until system-calculated brackets."}'::jsonb,
        CURRENT_TIMESTAMP);

-- bracketOf() in SQL: 1..10 from the ACTIVE ceilings; values at or below the
-- first ceiling (zero and negatives included) are bracket 1; NULL stays NULL.
CREATE FUNCTION "baylo_bracket_of"(v INTEGER) RETURNS INTEGER
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
  c INTEGER[];
  i INTEGER;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  SELECT "ceilings" INTO c FROM "BracketScheme" WHERE "status" = 'ACTIVE' LIMIT 1;
  IF c IS NULL THEN c := ARRAY[100,250,500,900,1500,2500,4000,9000,12000]; END IF;
  FOR i IN 1..array_length(c, 1) LOOP
    IF v <= c[i] THEN RETURN i; END IF;
  END LOOP;
  RETURN array_length(c, 1) + 1;
END
$$;

CREATE FUNCTION "baylo_item_set_bracket"() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  NEW."bracket" := "baylo_bracket_of"(NEW."valueLeaves");
  RETURN NEW;
END
$$;

DROP INDEX IF EXISTS "Item_status_bracket_idx";
ALTER TABLE "Item" DROP COLUMN "bracket";
ALTER TABLE "Item" ADD COLUMN "bracket" INTEGER;
UPDATE "Item" SET "bracket" = "baylo_bracket_of"("valueLeaves");
CREATE INDEX "Item_status_bracket_idx" ON "Item"("status", "bracket");

-- Naming "bracket" too means a hand-written value is overwritten: the column
-- can only ever hold what the active scheme says.
CREATE TRIGGER "Item_set_bracket"
BEFORE INSERT OR UPDATE OF "valueLeaves", "bracket" ON "Item"
FOR EACH ROW EXECUTE FUNCTION "baylo_item_set_bracket"();
