-- Similar-photo check on Baylo's own model (29 Nov 2026). Owner-approved
-- after the defense: the paid vision API is replaced by DINOv2 (open-source)
-- run on our server; see @/lib/image-embedding.
--
-- ADDITIVE ONLY.
--   ItemImage.embedding  the photo's 384-number DINOv2 embedding; empty until
--                        computed (after posting, or by
--                        scripts/backfill-photo-embeddings.ts).
--   Item.similarPhotoPct the highest confidence (0..100) that one of this
--                        listing's photos is another trader's photo, stored
--                        when it is 80 or more, so the listing can say
--                        "85% similar to another listing". NULL otherwise.
ALTER TABLE "ItemImage" ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[];
ALTER TABLE "Item" ADD COLUMN "similarPhotoPct" INTEGER;
