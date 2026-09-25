-- A ticket dropped in In Progress while another is writing the same files
-- waits there as queued, and starts once that one stops running.
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'queued' BEFORE 'running';
