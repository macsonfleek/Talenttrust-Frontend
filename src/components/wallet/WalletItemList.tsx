'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import type { WalletItem } from '@/types/domain';
import { useToast } from '@/components/toast/toast-provider';
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard';
import { execCommandFallback } from '@/lib/clipboardFallback';
import EditableWalletRow from './EditableWalletRow';

interface CopyWalletAddressButtonProps {
  /** Full (untruncated) wallet address/identifier to copy. */
  address: string;
  /** Display name of the wallet item, used to build a descriptive aria-label. */
  itemName: string;
  /** Wallet item id, used to build a stable test id. */
  itemId: string;
}

/**
 * Icon-button that copies a wallet item's address/identifier to the clipboard.
 *
 * - Uses the Clipboard API with a documented `execCommand` fallback
 *   (`@/lib/clipboardFallback`) for contexts where `navigator.clipboard` is
 *   unavailable (e.g. non-HTTPS, older browsers).
 * - Surfaces success/failure through the global toast system.
 * - Keyboard-operable (native `<button>`) with a descriptive `aria-label`.
 * - `aria-pressed` reflects the transient "copied" confirmation state.
 */
function CopyWalletAddressButton({ address, itemName, itemId }: CopyWalletAddressButtonProps) {
  const { showSuccess, showError } = useToast();

  const { copied, copy } = useCopyToClipboard({
    onSuccess: () => {
      showSuccess({ title: `Copied wallet address for ${itemName} to clipboard.` });
    },
    onError: () => {
      // Documented fallback: try execCommand when the Clipboard API is unavailable
      const success = execCommandFallback(address);
      if (success) {
        showSuccess({ title: `Copied wallet address for ${itemName} to clipboard.` });
      } else {
        showError({ title: `Failed to copy wallet address for ${itemName}. Please copy it manually.` });
      }
    },
  });

  const handleClick = useCallback(() => {
    copy(address);
  }, [copy, address]);

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={`Copy wallet address for ${itemName}`}
      aria-pressed={copied}
      data-testid={`copy-wallet-address-btn-${itemId}`}
      title="Copy wallet address"
      className={`inline-flex shrink-0 items-center rounded p-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
        copied
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-200'
      }`}
    >
      {copied ? (
        <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

export interface WalletItemListProps {
  /** Array of wallet items to render */
  items: WalletItem[];
  /** Set of currently selected item IDs */
  selectedIds: Set<string>;
  /** Callback fired when an item's selection status is toggled */
  onToggleSelect: (id: string) => void;
  /** Callback fired when Select All / Deselect All checkbox is clicked */
  onToggleSelectAll: () => void;
  /** Single item delete handler */
  onDeleteItem?: (id: string) => void;
  /** The ID of the item currently being edited, or null */
  editingId?: string | null;
  /** Callback fired when an item enters edit mode */
  onEditItem?: (id: string) => void;
  /** Callback fired when an edit is saved */
  onSaveEdit?: (id: string, updated: WalletItem) => void;
  /** Callback fired when editing is cancelled */
  onCancelEdit?: (id: string) => void;
}

export const WalletItemList: React.FC<WalletItemListProps> = ({
  items,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onDeleteItem,
  editingId,
  onEditItem,
  onSaveEdit,
  onCancelEdit,
}) => {
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);

  const handleDelete = useCallback((id: string) => {
    onDeleteItem?.(id);
  }, [onDeleteItem]);

  const hasDelete = typeof onDeleteItem === 'function';

  const isAllSelected = items.length > 0 && selectedIds.size === items.length;
  const isSomeSelected = selectedIds.size > 0 && selectedIds.size < items.length;

  useEffect(() => {
    if (selectAllCheckboxRef.current) {
      selectAllCheckboxRef.current.indeterminate = isSomeSelected;
    }
  }, [isSomeSelected]);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className="w-full overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900" data-wallet-table>
      <table className="w-full text-left text-sm" aria-label="Wallet items table">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
          <tr>
            <th scope="col" className="w-12 px-4 py-3 text-center">
              <input
                ref={selectAllCheckboxRef}
                type="checkbox"
                checked={isAllSelected}
                onChange={onToggleSelectAll}
                aria-label={isAllSelected ? 'Deselect all wallet items' : 'Select all wallet items'}
                data-testid="select-all-checkbox"
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
              />
            </th>
            <th scope="col" className="px-4 py-3">Item</th>
            <th scope="col" className="px-4 py-3">Type</th>
            <th scope="col" className="px-4 py-3">Balance</th>
            <th scope="col" className="px-4 py-3">Status</th>
            <th scope="col" className="px-4 py-3">Created</th>
            <th scope="col" className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((item) => {
            const isSelected = selectedIds.has(item.id);
            const isEditing = editingId === item.id;

            // Editing path: delegate entirely to EditableWalletRow (renders its own <tr>)
            if (isEditing && onSaveEdit && onCancelEdit && onEditItem) {
              return (
                <EditableWalletRow
                  key={item.id}
                  item={item}
                  editing
                  selected={isSelected}
                  onToggleSelect={onToggleSelect}
                  onEdit={onEditItem}
                  onSave={onSaveEdit}
                  onCancel={onCancelEdit}
                  onDelete={hasDelete ? handleDelete : undefined}
                />
              );
            }

            // Non-editing path: render row directly with copy-address button
            return (
              <tr
                key={item.id}
                data-testid={`wallet-item-row-${item.id}`}
                data-selected={isSelected || undefined}
                className={`transition-colors hover:bg-slate-50/80 focus-within:bg-slate-100/80 dark:hover:bg-slate-800/40 dark:focus-within:bg-slate-800/60 ${
                  isSelected ? 'bg-blue-50/40 dark:bg-slate-800/60' : ''
                }`}
              >
                <td className="w-12 px-4 py-4 text-center">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect(item.id)}
                    aria-label={`Select ${item.name}`}
                    data-testid={`select-item-checkbox-${item.id}`}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-800"
                  />
                </td>
                <td className="px-4 py-4 font-semibold text-slate-900 dark:text-slate-100">
                  {item.name}
                  {item.address && (
                    <span className="mt-0.5 flex items-center gap-1">
                      <span className="font-mono text-xs text-slate-400 truncate max-w-[160px]" title={item.address}>
                        {item.address}
                      </span>
                      <CopyWalletAddressButton address={item.address} itemName={item.name} itemId={item.id} />
                    </span>
                  )}
                </td>
                <td className="px-4 py-4 text-slate-600 dark:text-slate-300">{item.type}</td>
                <td className="px-4 py-4 font-medium text-slate-900 dark:text-slate-100">
                  {item.balance.toLocaleString()} {item.currency}
                </td>
                <td className="px-4 py-4">
                  <span
                    data-wallet-status={item.status}
                    className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                      item.status === 'Active'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                        : item.status === 'Pending'
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                        : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    }`}
                  >
                    {item.status}
                  </span>
                </td>
                <td className="px-4 py-4 text-xs text-slate-500 dark:text-slate-400">{item.createdAt}</td>
                <td className="px-4 py-4 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => onEditItem?.(item.id)}
                      aria-label={`Edit ${item.name}`}
                      data-testid={`edit-item-btn-${item.id}`}
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-blue-50 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:hover:bg-blue-950/50"
                    >
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    {onDeleteItem && (
                      <button
                        type="button"
                        onClick={() => handleDelete(item.id)}
                        className="rounded-lg p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-rose-500 dark:hover:bg-rose-950/50"
                        aria-label={`Delete ${item.name}`}
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

export default WalletItemList;
