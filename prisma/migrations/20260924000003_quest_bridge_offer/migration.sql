-- Adds SEND_BRIDGE_OFFER to QuestKind: a third MEDIUM-tier quest so that
-- tier actually rotates (it previously had exactly 2 entries for 2 slots,
-- meaning both were assigned every day with nothing to vary). Satisfied by
-- sending an offer with a non-null bridgeFeeLeaves -- see questSatisfied()
-- in @/lib/quests, which reads the same Offer.bridgeFeeLeaves column
-- COMPLETE_BRIDGE_TRADE already reads off TradeRequest, one step earlier in
-- the trade lifecycle. No schema change beyond the enum value.

ALTER TYPE "QuestKind" ADD VALUE IF NOT EXISTS 'SEND_BRIDGE_OFFER';
