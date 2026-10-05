import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReputationPage, { ReputationPageContent } from '../page';
import { reportError } from '@/lib/errorReporter';
import { STORAGE_KEY } from '@/lib/repository';
import { assertNoA11yViolations } from '@/test-utils/a11y';
import type { ReputationEvent } from '@/types/domain';

let mockProfileFailure = false;

jest.mock('@/lib/errorReporter', () => ({ reportError: jest.fn() }));
jest.mock('@/components/ReputationSummaryCard', () => ({
  __esModule: true,
  default: ({ name, score }: { name: string; score: number }) => (
    <p>
      {name}: {score}
    </p>
  ),
}));
jest.mock('@/components/ReputationProfile', () => {
  const React = require('react');
  return {
    __esModule: true,
    resolveReputationLevel: (score: number) =>
      score >= 4 ? 'Excellent' : score >= 2 ? 'Good' : 'New',
    default: ({ history = [] }: { history?: ReputationEvent[] }) => {
      const [draft, setDraft] = React.useState('');
      if (mockProfileFailure) throw new Error('Simulated profile rendering failure');
      return (
        <div>
          <label>
            Unsaved note
            <input
              value={draft}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setDraft(event.target.value)
              }
            />
          </label>
          <ul>
            {history.map((event) => (
              <li key={event.id}>{event.summary}</li>
            ))}
          </ul>
        </div>
      );
    },
  };
});

const event = { id: 'event-1', type: 'Review', summary: 'Saved feedback', date: '2026-09-01' };
const save = (history: ReputationEvent[]) =>
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ reputationEvents: history, contracts: [{ id: 'keep' }] }),
  );
const readyRefresh = () => screen.findByRole('button', { name: 'Refresh reputation history' });
const readyRetry = () => screen.findByRole('button', { name: 'Retry reputation history' });

beforeEach(() => {
  window.localStorage.clear();
  jest.clearAllMocks();
});
afterEach(() => {
  mockProfileFailure = false;
  jest.restoreAllMocks();
});

test('successful read preserves the current profile defaults and saved history', async () => {
  save([event]);
  render(<ReputationPage />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading reputation history');
  await screen.findByText('Saved feedback');
  expect(screen.getByText('User: 4.5')).toBeInTheDocument();
  expect(await readyRefresh()).toBeEnabled();
  expect(reportError).not.toHaveBeenCalled();
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
    JSON.stringify({ reputationEvents: [event], contracts: [{ id: 'keep' }] }),
  );
});

test('storage failure is visible, retry succeeds, and private exception text is never reported', async () => {
  save([event]);
  jest.spyOn(window.localStorage, 'getItem').mockImplementationOnce(() => {
    throw new Error('private-token-and-history');
  });
  render(<ReputationPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Check browser storage access and retry',
  );
  expect(screen.queryByText('No reputation yet')).not.toBeInTheDocument();
  expect(screen.queryByText('private-token-and-history')).not.toBeInTheDocument();
  expect(reportError).toHaveBeenCalledWith(
    new Error('Reputation history read failed'),
    'ReputationPage.load',
    'error',
    { reason: 'storage-unavailable' },
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry reputation history' }));
  await screen.findByText('Saved feedback');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('failed refresh preserves the successful snapshot, persisted bytes and unsaved component state', async () => {
  save([event]);
  render(<ReputationPage />);
  await screen.findByText('Saved feedback');
  fireEvent.change(screen.getByLabelText('Unsaved note'), { target: { value: 'Draft to retain' } });
  const raw = '{"private":"unparseable"';
  window.localStorage.setItem(STORAGE_KEY, raw);
  fireEvent.click(await readyRefresh());
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Saved reputation history is invalid',
  );
  expect(screen.getByText('Saved feedback')).toBeInTheDocument();
  expect(screen.getByLabelText('Unsaved note')).toHaveValue('Draft to retain');
  expect(window.localStorage.getItem(STORAGE_KEY)).toBe(raw);
  save([{ ...event, summary: 'Repaired feedback' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry reputation history' }));
  await screen.findByText('Repaired feedback');
  expect(screen.getByLabelText('Unsaved note')).toHaveValue('Draft to retain');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('duplicate refresh clicks are collapsed before a read can start', async () => {
  save([event]);
  const read = jest.spyOn(window.localStorage, 'getItem');
  render(<ReputationPage />);
  await screen.findByText('Saved feedback');
  const button = await readyRefresh();

  act(() => {
    button.click();
    button.click();
    button.click();
  });

  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read).toHaveBeenCalledTimes(2);
  expect(button).toBeEnabled();
});

test('a second refresh click during a pending read does not start a parallel read', async () => {
  save([event]);
  const read = jest.spyOn(window.localStorage, 'getItem');
  render(<ReputationPage />);
  await screen.findByText('Saved feedback');
  const button = await readyRefresh();

  act(() => {
    button.click();
    button.click();
  });

  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read).toHaveBeenCalledTimes(2);
  expect(button).toBeEnabled();
});

test('duplicate retry clicks after a failed read are still collapsed', async () => {
  save([event]);
  jest.spyOn(window.localStorage, 'getItem').mockImplementationOnce(() => {
    throw new Error('temporary failure');
  });
  render(<ReputationPage />);
  await screen.findByRole('alert');
  const button = await readyRetry();

  act(() => {
    button.click();
    button.click();
    button.click();
  });

  await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
  expect(reportError).toHaveBeenCalledTimes(1);
});

test('empty or legacy history is successful rather than a read failure', async () => {
  render(<ReputationPage />);
  await screen.findByText('User: 4.5');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('render failure can retry the retained successful snapshot without reading or modifying storage again', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  save([event]);
  const read = jest.spyOn(window.localStorage, 'getItem');
  const write = jest.spyOn(window.localStorage, 'setItem');
  mockProfileFailure = true;
  render(<ReputationPage />);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  mockProfileFailure = false;
  fireEvent.click(retry);
  await screen.findByText('Saved feedback');
  expect(read).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
});

test.each([null, undefined, { score: -1 }, { score: null }])(
  'retains the named content export empty-state contract for %p',
  (data) => {
    render(<ReputationPageContent reputationData={data} />);
    expect(screen.getByText('No reputation yet')).toBeInTheDocument();
  },
);

test('content export accepts zero score and forwards custom name', () => {
  render(
    <ReputationPageContent reputationData={{ score: 0, history: [event] }} userName="Alice" />,
  );
  expect(screen.getByText('Alice: 0')).toBeInTheDocument();
});

test('error and recovered states pass the shared accessibility audit', async () => {
  window.localStorage.setItem(STORAGE_KEY, 'broken');
  const view = render(<ReputationPage />);
  await screen.findByRole('alert');
  await assertNoA11yViolations(view.container);
  save([event]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry reputation history' }));
  await screen.findByText('Saved feedback');
  await assertNoA11yViolations(view.container);
});

test('pending loading state passes the shared accessibility audit', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  jest
    .spyOn(require('@/lib/readReputationHistory'), 'readReputationHistory')
    .mockReturnValueOnce(pending);
  const view = render(<ReputationPage />);
  await assertNoA11yViolations(view.container);
  expect(screen.getByRole('status')).toHaveTextContent('Loading reputation history');
  expect(screen.getByRole('button')).toBeDisabled();
  await act(async () => finish([]));
});

test('unexpected dependency exceptions have a bounded diagnostic', async () => {
  jest
    .spyOn(require('@/lib/readReputationHistory'), 'readReputationHistory')
    .mockImplementationOnce(() => {
      throw 'private-data';
    });
  render(<ReputationPage />);
  await screen.findByRole('alert');
  expect(reportError).toHaveBeenCalledWith(
    new Error('Reputation history read failed'),
    'ReputationPage.load',
    'error',
    { reason: 'read-failed' },
  );
});

test.each([false, true])(
  'unmount suppresses pending %s completion and diagnostics',
  async (reject) => {
    let finish!: (value?: unknown) => void;
    const pending = new Promise((resolve, rejectPromise) => {
      finish = reject ? rejectPromise : resolve;
    });
    jest
      .spyOn(require('@/lib/readReputationHistory'), 'readReputationHistory')
      .mockReturnValueOnce(pending);
    const view = render(<ReputationPage />);
    await act(async () => {
      await Promise.resolve();
    });
    view.unmount();
    await act(async () =>
      finish(reject ? new Error('invalid-data') : [event]),
    );
    expect(reportError).not.toHaveBeenCalled();
  },
);

test('StrictMode cleanup ignores an obsolete read and allows the current request to succeed', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const read = jest.spyOn(require('@/lib/readReputationHistory'), 'readReputationHistory');
  read.mockReturnValueOnce(pending).mockReturnValueOnce([event]);
  render(
    <React.StrictMode>
      <ReputationPage />
    </React.StrictMode>,
  );
  await screen.findByText('Saved feedback');
  await act(async () => finish([{ ...event, summary: 'Obsolete feedback' }]));
  expect(screen.queryByText('Obsolete feedback')).not.toBeInTheDocument();
});
