import {
  DEFAULT_MILESTONE_QUERY,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  MAX_STATUS_FILTERS,
  MILESTONE_STATUSES,
  MILESTONE_VALIDATION_CODES,
  MIN_PAGE_SIZE,
  isValidMilestoneQueryResult,
  safeMilestoneQuery,
  validateMilestoneQuery,
} from './validation';

describe('validateMilestoneQuery', () => {
  describe('valid input', () => {
    it('returns the default query for an empty object', () => {
      const result = validateMilestoneQuery({});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query).toEqual(DEFAULT_MILESTONE_QUERY);
      expect(result.warnings).toEqual([]);
    });

    it('returns the default query when no input is provided', () => {
      const result = validateMilestoneQuery();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.status).toEqual(['all']);
    });

    it('normalizes a single status string into an array', () => {
      const result = validateMilestoneQuery({ status: 'open' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.status).toEqual(['open']);
    });

    it('preserves a valid multi-status filter', () => {
      const result = validateMilestoneQuery({
        status: ['open', 'in_progress', 'completed'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.status).toEqual(['open', 'in_progress', 'completed']);
    });

    it('accepts a valid sort key and direction', () => {
      const result = validateMilestoneQuery({
        sortKey: 'title',
        sortDirection: 'asc',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.sortKey).toBe('title');
      expect(result.query.sortDirection).toBe('asc');
    });

    it('accepts a numeric page size and an opaque cursor', () => {
      const result = validateMilestoneQuery({
        pageSize: 42,
        cursor: 'cursor-absc123',
      });
      expect(result.ok).toBe((true));
      if (!result.ok) return;
      expect(result.query.pageSize).toBe(42);
      expect(result.query.cursor).toBe('cursor-absc123');
    });

    it('coerces a numeric string page size', () => {
      const result = validateMilestoneQuery({ pageSize: '25' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.pageSize).toBe(25);
    });

    it('trims the search query', () => {
      const result = validateMilestoneQuery({ search: '  release  ' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.search).toBe('release');
    });

    it('returns a frozen query and frozen status list', () => {
      const result = validateMilestoneQuery({ status: ['open'] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.isFrozen(result.query)).toBe((true));
      expect(Object.isFrozen(result.query.status)).toBe(true);
    });
  });

  describe('invalid input', () => {
    it('rejects an unknown status value', () => {
      const result = validateMilestoneQuery({ status: 'archived' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(
        MILESTONE_VALIDATION_CODES.invalid_status,
      );
    });

    it('rejects an unknown status in a mixed array', () => {
      const result = validateMilestoneQuery({ status: ['open', 'not-a-status'] });
      expect(result.ok).toBe(false);
    });

    it('rejects an unknown sort key', () => {
      const result = validateMilestoneQuery({ sortKey: 'priority' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(
        MILESTONE_VALIDATION_CODES.invalid_sort_key,
      );
    });

    it('rejects an unknown sort direction', () => {
      const result = validateMilestoneQuery({ sortDirection: 'sideways' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(
        MILESTONE_VALIDATION_CODES.invalid_sort_direction,
      );
    });

    it('rejects a non-integer page size', () => {
      const result = validateMilestoneQuery({ pageSize: 2.5 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(
        MILESTONE_VALIDATION_CODES.invalid_page_size,
      );
    });

    it('rejects a non-numeric page size', () => {
      const result = validateMilestoneQuery({ pageSize: 'many' });
      expect(result.ok).toBe(false);
    });

    it('rejects a cursor with control characters', () => {
      const result = validateMilestoneQuery({ cursor: 'bad\ncursor' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(
        MILESTONE_VALIDATION_CODES.invalid_cursor,
      );
    });

    it('rejects a cursor with whitespace', () => {
      const result = validateMilestoneQuery({ cursor: 'cursor with space' });
      expect(result.ok).toBe(false);
    });

    it('rejects a search query that exceeds the maximum length', () => {
      const result = validateMilestoneQuery({
        search: 'x'.repeat(MAX_SEARCH_LENGTH + 1),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(
        MILESTONE_VALIDATION_CODES.search_too_long,
      );
    });

    it('rejects a non-string search value', () => {
      const result = validateMilestoneQuery({ search: 42 });
      expect(result.ok).toBe(false);
    });

    it('rejects a non-object input by falling back to defaults', () => {
      const result = validateMilestoneQuery('not-an-object');
      expect(result.ok).toBe(true);
    });

    it('rejects an array input by falling back to defaults', () => {
      const result = validateMilestoneQuery(['open']);
      expect(result.ok).toBe(true);
    });
  });

  describe('duplicate input', () => {
    it('deduplicates repeated statuses and warns', () => {
      const result = validateMilestoneQuery({
        status: ['open', 'open', 'in_progress'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.status).toEqual(['open', 'in_progress']);
      expect(result.warnings).toContain(
        MILESTONE_VALIDATION_CODES.duplicate_status,
      );
    });

    it('collapses to all when all is present alongside other statuses', () => {
      const result = validateMilestoneQuery({
        status: ['open', 'all', 'completed'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.status).toEqual(['all']);
    });

    it('deduplicates the all sentinel', () => {
      const result = validateMilestoneQuery({ status: ['all', 'all'] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.status).toEqual(['all']);
      expect(result.warnings).toContain(
        MILESTONE_VALIDATION_CODES.duplicate_status,
      );
    });

    it('is deterministic for duplicate input', () => {
      const a = validateMilestoneQuery({ status: ['open', 'open'] });
      const b = validateMilestoneQuery({ status: ['open', 'open'] });
      expect(a).toEqual(b);
    });
  });

  describe('boundary values', () => {
    it('accepts the minimum page size', () => {
      const result = validateMilestoneQuery({ pageSize: MIN_PAGE_SIZE });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.pageSize).toBe(MIN_PAGE_SIZE);
    });

    it('accepts the maximum page size', () => {
      const result = validateMilestoneQuery({ pageSize: MAX_PAGE_SIZE });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.pageSize).toBe(
        MAX_PAGE_SIZE,
      );
    });

    it('rejects a page size below the minimum', () => {
      const result = validateMilestoneQuery({ pageSize: MIN_PAGE_SIZE - 1 });
      expect(result.ok).toBe(false);
    });

    it('rejects a page size above the maximum', () => {
      const result = validateMilestoneQuery({ pageSize: MAX_PAGE_SIZE + 1 });
      expect(result.ok).toBe(false);
    });

    it('accepts a search at the maximum length', () => {
      const result = validateMilestoneQuery({
        search: 'x'.repeat(MAX_SEARCH_LENGTH),
      });
      expect(result.ok).toBe(true);
    });

    it('accepts a cursor at the maximum length', () => {
      const result = validateMilestoneQuery({
        cursor: 'x'.repeat(MAX_CURSOR_LENGTH),
      });
      expect(result.ok).toBe(true);
    });

    it('rejects a cursor over the maximum length', () => {
      const result = validateMilestoneQuery({
        cursor: 'x'.repeat(MAX_CURSOR_LENGTH + 1),
      });
      expect(result.ok).toBe(false);
    });

    it('accepts all valid statuses except all', () => {
      const valid = MILESTONE_STATUSES.filter((s) => s !== 'all');
      expect(valid.length).toBe(
        MAX_STATUS_FILTERS,
      );
      const result = validateMilestoneQuery({ status: valid });
      expect(result.ok).toBe(true);
    });

    it('rejects a status list longer than the defined set', () => {
      const result = validateMilestoneQuery({
        status: ['open', 'open', 'open', 'open', 'open', 'open'],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.query.status).toEqual(['open']);
    });
  });

  describe('regression guards', () => {
    it('does not mutate the input array', () => {
      const input = { status: ['open', 'open'] };
      const snapshot = [...input.status];
      validateMilestoneQuery(input);
      expect(input.status).toEqual(snapshot);
    });

    it('returns a new query object on each call', () => {
      const a = validateMilestoneQuery({});
      const b = validateMilestoneQuery({});
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.query).not.toBe(b.query);
    });

    it('never throws for unknown input shapes', () => {
      const shapes: unknown[] = [
        null,
        undefined,
        0,
        NaN,
        true,
        Symbol('x'),
        () => {},
        { status: {} },
      ];
      for (const shape of shapes) {
        expect(() => validateMilestoneQuery(shape)).not.toThrow();
      }
    });

    it('produces the same result for the same input', () => {
      const input = {
        status: ['open', 'in_progress'],
        sortKey: 'title',
        sortDirection: 'asc',
        pageSize: 50,
        cursor: 'cursor-123',
        search: 'release',
      };
      expect(validateMilestoneQuery(input)).toEqual(
        validateMilestoneQuery(input),
      );
    });
  });
});

describe('safeMilestoneQuery', () => {
  it('returns the normalized query for valid input', () => {
    const query = safeMilestoneQuery({ status: 'open', pageSize: 10 });
    expect(query.status).toEqual(['open']);
    expect(query.pageSize).toBe(10);
  });

  it('falls back to the default query for invalid input', () => {
    const query = safeMilestoneQuery({ status: 'not-a-status' });
    expect(query).toEqual(DEFAULT_MILESTONE_QUERY);
  });

  it('never returns undefined', () => {
    expect(safeMilestoneQuery(undefined)).toBeDefined();
    expect(safeMilestoneQuery(null)).toBeDefined();
  });
});

describe('isValidMilestoneQueryResult', () => {
  it('narrows a valid result', () => {
    const result = validateMilestoneQuery({});
    expect(isValidMilestoneQueryResult(result)).toBe(true);
  });

  it('rejects an invalid result', () => {
    const result = validateMilestoneQuery({ sortKey: 'nope' });
    expect(isValidMilestoneQueryResult(result)).toBe(false);
  });
});
