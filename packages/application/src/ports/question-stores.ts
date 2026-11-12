import type { Lang, QuestionPhase, VerifiedAnswer } from '@octobrief/domain'

export interface Question {
  readonly id: string
  readonly projectId: string
  readonly askedBy: string
  readonly text: string
  readonly lang: Lang
  readonly phase: QuestionPhase
  /** Present exactly when the phase is `done`. */
  readonly answer: VerifiedAnswer | null
  /** A stable error code when the phase is `failed`. */
  readonly error: string | null
  readonly askedAt: Date
  readonly answeredAt: Date | null
}

/** Questions as who asked them sees them: every call runs as `viewerId`. */
export interface QuestionRepository {
  create(
    viewerId: string,
    question: { projectId: string; text: string; lang: Lang },
  ): Promise<Question>
  /** The viewer's own questions on the project, newest first. */
  list(viewerId: string, projectId: string, limit: number): Promise<Question[]>
  find(viewerId: string, projectId: string, questionId: string): Promise<Question | null>
  remove(viewerId: string, questionId: string): Promise<void>
}

export interface QuestionToAnswer {
  readonly id: string
  readonly projectId: string
  readonly askedBy: string
  readonly text: string
  readonly lang: Lang
}

/** The worker's view of the questions. */
export interface QuestionWorkStore {
  /** A question still to answer; null when it is gone or already settled. */
  pending(questionId: string): Promise<QuestionToAnswer | null>
  setPhase(questionId: string, phase: Extract<QuestionPhase, 'reading' | 'checking'>): Promise<void>
  saveAnswer(
    questionId: string,
    answer: VerifiedAnswer,
    run: { turns: number; backend: string },
  ): Promise<void>
  saveFailure(questionId: string, code: string): Promise<void>
}
