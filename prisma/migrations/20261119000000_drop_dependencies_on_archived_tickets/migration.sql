-- Archiving a ticket now removes it from other tickets' dependency lists.
-- Clear the edges left behind by tickets archived before that (not by an Epic).
DELETE FROM "ticket_dependency"
WHERE "dependsOnTicketId" IN (
  SELECT "id" FROM "ticket" WHERE "archived" = true AND "archivedWithEpic" = false
);
