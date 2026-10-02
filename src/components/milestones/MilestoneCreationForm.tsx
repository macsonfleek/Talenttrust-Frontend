'use client';

import React, { useState, useCallback, FormEvent, useRef } from 'react';
import { FormField } from '@/components/FormField';
import { ErrorSummary } from '@/components/ErrorSummary';
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap';
import { sanitizeUserText } from '@/lib/sanitizeUserText';
import {
  validateMilestone,
  MAX_MILESTONE_TITLE_LENGTH,
  ALLOWED_CURRENCIES,
  ALLOWED_STATUSES,
  MAX_PAYOUT_VALUE,
  MAX_PAYOUT_DECIMAL_PLACES,
} from '@/lib/validateMilestone';
import {
  combineValidators,
  validateRequired,
  validateMaxLength,
  validatePositiveNumber,
  validateNumberRange,
  validateDecimalPlaces,
  validateDueDate,
  validateAllowedValues,
} from '@/lib/fieldValidators';
import type { Milestone } from '@/types/domain';

// Re-export so existing imports of MAX_MILESTONE_TITLE_LENGTH from this module
// continue to work without breaking changes.
export { MAX_MILESTONE_TITLE_LENGTH };

/** Status options available when creating a milestone. */
const STATUS_OPTIONS = ALLOWED_STATUSES as unknown as Milestone['status'][];

/** Currency options available when creating a milestone. */
const CURRENCY_OPTIONS = ALLOWED_CURRENCIES;

export interface MilestoneCreationFormProps {
  /**
   * Called with the fully-constructed `Milestone` object when the form
   * passes validation and the user submits.
   */
  onSubmit: (milestone: Milestone) => void;
  /** Called when the user cancels out of the form without saving. */
  onCancel: () => void;
  /**
   * Id of the parent contract this milestone is being created for. When
   * supplied (i.e. the form is opened from a contract detail context),
   * it is stamped onto the constructed `Milestone` so
   * `listMilestonesByContract` can later resolve it back to that contract.
   */
  contractId?: string;
}

/**
 * Accessible modal form for creating a new milestone.
 *
 * Mirrors the style and accessibility patterns of `ContractCreationForm`:
 * - `role="dialog"` / `aria-modal` for correct AT announcement.
 * - Shared dialog focus trapping, Escape handling, and trigger-focus restoration.
 * - `ErrorSummary` with `role="alert"` focus management for invalid submissions.
 * - `FormField` handles per-field `aria-invalid`, `aria-describedby`, and
 *   error-border injection.
 * - `id` is generated from the title slug + a timestamp so duplicate titles
 *   never collide across sessions.
 *
 * @example
 * ```tsx
 * <MilestoneCreationForm
 *   onSubmit={(m) => { saveMilestone(m); setMilestones(listMilestones()); }}
 *   onCancel={() => setShowForm(false)}
 * />
 * ```
 */
export const MilestoneCreationForm: React.FC<MilestoneCreationFormProps> = ({
  onSubmit,
  onCancel,
  contractId,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [payout, setPayout] = useState('');
  const [currency, setCurrency] = useState<string>('USD');
  const [status, setStatus] = useState<Milestone['status']>('Pending');
  const [dueDate, setDueDate] = useState('');
  /**
   * Field-level errors produced by the last submit attempt.
   *
   * Invariant: only ever written from `handleSubmit`, so the summary and the
   * per-field messages are always a snapshot of one validation pass and can
   * never disagree with each other. Reset by the next submit attempt.
   */
  const [errors, setErrors] = useState<Array<{ fieldId: string; message: string }>>([]);
  // Tracks whether the user has attempted a submit, so the submit button is
  // only disabled *after* the first failed validation (never before).
  const [hasSubmitted, setHasSubmitted] = useState(false);

  // Inline validators for real-time validation
  const validateTitleField = combineValidators([
    validateRequired('Title'),
    validateMaxLength('Title', MAX_MILESTONE_TITLE_LENGTH),
  ]);

  const validatePayoutField = combineValidators([
    validateRequired('Payout amount'),
    validatePositiveNumber('Payout amount'),
    validateNumberRange('Payout amount', 0.01, MAX_PAYOUT_VALUE),
    validateDecimalPlaces('Payout amount', MAX_PAYOUT_DECIMAL_PLACES),
  ]);

  const validateCurrencyField = combineValidators([
    validateRequired('Currency'),
    validateAllowedValues('Currency', ALLOWED_CURRENCIES),
  ]);

  const validateStatusField = combineValidators([
    validateAllowedValues('Status', ALLOWED_STATUSES),
  ]);

  const validateDueDateField = validateDueDate();

  /**
   * Delegates to the pure `validateMilestone` helper and returns the resulting
   * errors array. Keeping the call-site here (rather than inlining the logic)
   * means the form stays thin while the rules live in a testable module.
   */
  const validateForm = useCallback((): Array<{ fieldId: string; message: string }> => {
    return validateMilestone({ title, payout, currency, dueDate, status });
  }, [title, payout, currency, dueDate, status]);

  /**
   * Handles form submission: validates, then calls `onSubmit` with the
   * constructed `Milestone` object on success.
   */
  const handleSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setHasSubmitted(true);
      const validationErrors = validateForm();
      setErrors(validationErrors);

      if (validationErrors.length > 0) return;

      // Generate a stable id from title slug + current timestamp
      const sanitizedTitle = sanitizeUserText(title, MAX_MILESTONE_TITLE_LENGTH);
      const slug = sanitizedTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const id = `${slug}-${Date.now()}`;

      const milestone: Milestone = {
        id,
        title: sanitizedTitle,
        status,
        payout: parseFloat(payout),
        currency: currency.trim(),
        dueDate: dueDate.trim() || undefined,
        contractId,
      };

      onSubmit(milestone);
    },
    [title, payout, currency, status, dueDate, contractId, validateForm, onSubmit],
  );

  // Check if the form has any validation errors to disable submit button
  const _hasErrors = () => {
    if (!hasSubmitted) return false;

    const allErrors = validateMilestone({ title, payout, currency, dueDate, status });
    return allErrors.length > 0;
  };

  const getFieldError = (fieldId: string): string | undefined =>
    errors.find((e) => e.fieldId === fieldId)?.message;

  useDialogFocusTrap({
    isOpen: true,
    dialogRef,
    initialFocusRef: titleInputRef,
    onEscape: onCancel,
    restoreFocus: true,
  });

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
      onClick={onCancel}
      role="dialog"
      aria-labelledby="create-milestone-title"
      aria-modal="true"
      tabIndex={-1}
    >
      <div
        className="bg-white rounded-3xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="create-milestone-title"
          className="text-2xl font-bold text-slate-900 mb-6"
        >
          Add Milestone
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          <ErrorSummary errors={errors} />

          <FormField
            label="Title"
            id="milestone-title"
            error={getFieldError('milestone-title')}
            validate={validateTitleField}
            required
          >
            <input
              ref={titleInputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., Frontend Development – Sprint 1"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-4">
            <FormField
              label="Payout Amount"
              id="milestone-payout"
              error={getFieldError('milestone-payout')}
              validate={validatePayoutField}
              required
            >
              <input
                type="text"
                inputMode="decimal"
                value={payout}
                onChange={(e) => setPayout(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="e.g., 2500"
              />
            </FormField>

            <FormField
              label="Currency"
              id="milestone-currency"
              error={getFieldError('milestone-currency')}
              validate={validateCurrencyField}
              required
            >
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </FormField>
          </div>

          <FormField 
            label="Status" 
            id="milestone-status" 
            error={getFieldError('milestone-status')}
            validate={validateStatusField}
          >
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Milestone['status'])}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </FormField>

          <FormField
            label="Due Date"
            id="milestone-dueDate"
            helperText="Optional — e.g., Jun 1, 2025"
            error={getFieldError('milestone-dueDate')}
            validate={validateDueDateField}
          >
            <input
              type="text"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Jun 1, 2025"
            />
          </FormField>

          <div className="flex gap-3 justify-end mt-6">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 font-medium focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 font-medium focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            >
              Add Milestone
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
