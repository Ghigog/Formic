-- Dragging a ticket onto the "New request" button archives it: a terminal
-- status with no column, kept only for the Archive view.
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'closed';
