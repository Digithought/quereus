import React, { useMemo } from 'react';
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
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

type Row = Record<string, SqlValue>;

export const ResultsGrid: React.FC = () => {
  const { queryHistory, activeResultId } = useSessionStore();

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
