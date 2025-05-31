import React, { useMemo, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  createColumnHelper,
  flexRender,
} from '@tanstack/react-table';
import type { SqlValue } from '@quereus/quereus';
import { useSessionStore } from '../stores/sessionStore.js';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, Check } from 'lucide-react';

type Row = Record<string, SqlValue>;

export const ResultsGrid: React.FC = () => {
  const { queryHistory, activeResultId } = useSessionStore();
  const [copySuccess, setCopySuccess] = useState<string | null>(null);

  const activeResult = queryHistory.find(result => result.id === activeResultId);
  const data = activeResult?.results || [];

  const columnHelper = createColumnHelper<Row>();

  const columns = useMemo(() => {
    if (data.length === 0) return [];

    const firstRow = data[0];
    return Object.keys(firstRow).map(key =>
      columnHelper.accessor(key, {
        header: key,
        cell: (info) => {
          const value = info.getValue();
          if (value === null) {
            return <span className="text-gray-400 italic">NULL</span>;
          }
          if (typeof value === 'string' && value.length > 100) {
            return (
              <span title={value}>
                {value.substring(0, 100)}...
              </span>
            );
          }
          return String(value);
        },
      })
    );
  }, [data, columnHelper]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    initialState: {
      pagination: {
        pageSize: 50,
      },
    },
  });

  const copyToClipboard = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(type);
      setTimeout(() => setCopySuccess(null), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const copyAsCSV = async () => {
    if (data.length === 0) return;

    const headers = Object.keys(data[0]);
    const csvRows = [
      headers.join(','), // Header row
      ...data.map(row =>
        headers.map(header => {
          const value = row[header];
          if (value === null) return '';
          if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return String(value);
        }).join(',')
      )
    ];

    const csvContent = csvRows.join('\n');
    await copyToClipboard(csvContent, 'csv');
  };

  const copyAsTable = async () => {
    if (data.length === 0) return;

    const headers = Object.keys(data[0]);

    // Calculate column widths
    const colWidths = headers.map(header => {
      const headerWidth = header.length;
      const dataWidth = Math.max(...data.map(row => {
        const value = row[header];
        return value === null ? 4 : String(value).length; // 4 for "NULL"
      }));
      return Math.max(headerWidth, dataWidth, 8); // Min width of 8
    });

    // Create table text
    const separator = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+';
    const headerRow = '| ' + headers.map((header, i) => header.padEnd(colWidths[i])).join(' | ') + ' |';

    const dataRows = data.map(row =>
      '| ' + headers.map((header, i) => {
        const value = row[header];
        const displayValue = value === null ? 'NULL' : String(value);
        return displayValue.padEnd(colWidths[i]);
      }).join(' | ') + ' |'
    );

    const tableText = [
      separator,
      headerRow,
      separator,
      ...dataRows,
      separator,
      `(${data.length} rows)`
    ].join('\n');

    await copyToClipboard(tableText, 'table');
  };

  if (activeResult?.error) {
    return (
      <div className="p-4">
        <div className="error-message">
          <strong>Error:</strong> {activeResult.error}
        </div>
      </div>
    );
  }

  if (!activeResult) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <p>No query results to display</p>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="p-4">
        <div className="success-message">
          Query executed successfully. No rows returned.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {data.length} rows
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={copyAsCSV}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
            title="Copy as CSV"
          >
            {copySuccess === 'csv' ? (
              <>
                <Check size={12} />
                Copied!
              </>
            ) : (
              <>
                <Copy size={12} />
                Copy CSV
              </>
            )}
          </button>

          <button
            onClick={copyAsTable}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded transition-colors"
            title="Copy as formatted table"
          >
            {copySuccess === 'table' ? (
              <>
                <Check size={12} />
                Copied!
              </>
            ) : (
              <>
                <Copy size={12} />
                Copy Table
              </>
            )}
          </button>
        </div>
      </div>

      {/* Table container */}
      <div className="flex-1 overflow-auto">
        <table className="results-table">
          <thead>
            {table.getHeaderGroups().map(headerGroup => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map(header => (
                  <th
                    key={header.id}
                    className={header.column.getCanSort() ? 'cursor-pointer select-none' : ''}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-2">
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      {{
                        asc: ' ↑',
                        desc: ' ↓',
                      }[header.column.getIsSorted() as string] ?? null}
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(row => (
              <tr key={row.id}>
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {table.getPageCount() > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-gray-400">
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              ({data.length} total rows)
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              onClick={() => table.setPageIndex(0)}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              <ChevronRight size={16} />
            </button>
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50"
              onClick={() => table.setPageIndex(table.getPageCount() - 1)}
              disabled={!table.getCanNextPage()}
            >
              <ChevronsRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
