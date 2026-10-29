import { z } from "zod";

import { isGuestId, type GuestId } from "@/lib/calls/guests";
import { MEETING_REPEATS } from "@/lib/db/repository";

const guest = z.string().refine(isGuestId, "Unknown guest.").transform((g) => g as GuestId);

export const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  startsAt: z.coerce.date(),
  agenda: z.string().max(20_000).optional(),
  guests: z.array(guest).max(50).optional(),
  repeat: z.enum(MEETING_REPEATS).optional(),
});

export const updateSchema = createSchema.partial();
