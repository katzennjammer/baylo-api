-- Audit vocabulary for business-document reviews.
--
-- The schema half of the admin queue, landed on main by itself for the reason
-- the previous migration's header gives: Prisma refuses to read a row whose
-- enum column holds a value the generated client does not model, so the first
-- AdminAction written with ORGANIZATION_VERIFIED from a feature branch would
-- 500 every main checkout on the whole AdminAction table — which is the audit
-- log, read by every admin page.
--
-- Two kinds and not one, matching the ID_VERIFICATION_APPROVED/REJECTED pair:
-- an audit log that records "a decision was made" without recording which one
-- is a log you have to open the target row to read, and the target row is
-- exactly what an audit log exists to be independent of.

ALTER TYPE "AdminActionKind" ADD VALUE 'ORGANIZATION_VERIFIED';

ALTER TYPE "AdminActionKind" ADD VALUE 'ORGANIZATION_REJECTED';

ALTER TYPE "AdminTargetType" ADD VALUE 'ORGANIZATION';
