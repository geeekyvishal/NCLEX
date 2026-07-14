/**
 * FSRS Scheduler module.
 * Wraps ts-fsrs to initialize card state and calculate card rescheduling parameters.
 */
import {
  fsrs,
  generatorParameters,
  createEmptyCard,
  Card as FSRSCard,
  Rating as FSRSRating,
  State as FSRSState,
  RecordLogItem,
} from "ts-fsrs";

export interface FsrsParamsInput {
  weights?: number[];
  request_retention?: number;
}

/**
 * Initializes the FSRS state for a new card.
 *
 * @param now The creation or initial queue insertion date.
 * @returns An object containing the initial FSRS card fields.
 */
export function initializeCardState(now: Date = new Date()) {
  const card = createEmptyCard(now);
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as number,
    due: card.due,
    last_review: card.last_review ?? null,
  };
}

/**
 * Reschedules a card based on a user review rating.
 *
 * @param card The current FSRS-related fields of the card.
 * @param rating The review rating (1 = Again, 2 = Hard, 3 = Good, 4 = Easy).
 * @param reviewTime The time the review was performed.
 * @param params Optional custom FSRS parameters (weights, target retention).
 * @returns The scheduling record containing the updated card and review log.
 */
export function rescheduleCard(
  card: {
    stability: number;
    difficulty: number;
    reps: number;
    lapses: number;
    state: number;
    due: Date | string;
    last_review?: Date | string | null;
  },
  rating: number,
  reviewTime: Date = new Date(),
  params?: FsrsParamsInput,
): RecordLogItem {
  if (rating < 1 || rating > 4) {
    throw new Error(`Invalid FSRS rating: ${rating}. Must be between 1 and 4.`);
  }

  const fsrsParams = generatorParameters({
    request_retention: params?.request_retention ?? 0.9,
    w: params?.weights,
  });

  const f = fsrs(fsrsParams);

  // Map the raw card record to the shape ts-fsrs expects
  const fsrsCard: FSRSCard = {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state as FSRSState,
    last_review: card.last_review ? new Date(card.last_review) : undefined,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
  };

  return f.next(fsrsCard, reviewTime, rating as (1 | 2 | 3 | 4));
}
