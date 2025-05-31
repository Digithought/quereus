import React, { useState, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { X, CheckCircle, AlertTriangle, Database, Download } from 'lucide-react';
import type { CsvPreview } from '../worker/types.js';

interface CsvImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CsvImportModal: React.FC<CsvImportModalProps> = ({ isOpen, onClose }) => {
  const { api } = useSessionStore();
  const [csvData, setCsvData] = useState<string>('');
  const [tableName, setTableName] = useState<string>('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Auto-generate table name from filename
    const baseTableName = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
    setTableName(baseTableName);

    setIsLoading(true);
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        const content = e.target?.result as string;
        setCsvData(content);

        if (api) {
          try {
            const previewData = await api.previewCsv(content);
            setPreview(previewData);
          } catch (error) {
            console.error('Preview failed:', error);
            setPreview({
              columns: [],
              sampleRows: [],
              totalRows: 0,
              errors: [error instanceof Error ? error.message : 'Unknown error'],
              inferredTypes: {}
            });
          }
        }
        setIsLoading(false);
      };
      reader.readAsText(file);
    } catch (error) {
      setIsLoading(false);
      console.error('File read failed:', error);
    }
  };

  const handleImport = async () => {
    if (!api || !csvData || !tableName.trim()) return;

    setIsImporting(true);
    try {
      const result = await api.importCsv(csvData, tableName.trim());
      setImportResult({
        success: true,
        message: `Successfully imported ${result.rowsImported} rows into table "${tableName}"`
      });
    } catch (error) {
      setImportResult({
        success: false,
        message: error instanceof Error ? error.message : 'Import failed'
      });
    }
    setIsImporting(false);
  };

  const handleClose = () => {
    setCsvData('');
    setTableName('');
    setPreview(null);
    setImportResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Import CSV Data
          </h2>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto max-h-[70vh]">
          {!csvData ? (
            /* File Selection */
            <div className="text-center py-12">
              <div className="mb-4">
                <Download size={48} className="mx-auto text-gray-400" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
                Choose CSV File
              </h3>
              <p className="text-gray-500 dark:text-gray-400 mb-6">
                Select a CSV file to import into a new table
              </p>
              <button
                onClick={handleFileSelect}
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
              >
                Select File
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          ) : isLoading ? (
            /* Loading */
            <div className="text-center py-12">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
              <p className="text-gray-600 dark:text-gray-400">Analyzing CSV file...</p>
            </div>
          ) : preview ? (
            /* Preview and Import */
            <div className="space-y-6">
              {/* Import Result */}
              {importResult && (
                <div className={`p-4 rounded-lg border ${
                  importResult.success
                    ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                    : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
                }`}>
                  <div className="flex items-center gap-2">
                    {importResult.success ? (
                      <CheckCircle size={16} />
                    ) : (
                      <AlertTriangle size={16} />
                    )}
                    <span className="text-sm font-medium">{importResult.message}</span>
                  </div>
                </div>
              )}

              {/* Errors */}
              {preview.errors.length > 0 && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-red-800 dark:text-red-200 mb-2">
                    CSV Parsing Errors:
                  </h4>
                  <ul className="text-sm text-red-700 dark:text-red-300 space-y-1">
                    {preview.errors.map((error, index) => (
                      <li key={index}>• {error}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Table Configuration */}
              <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4">
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-3">
                  Table Configuration
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Table Name
                    </label>
                    <input
                      type="text"
                      value={tableName}
                      onChange={(e) => setTableName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                      placeholder="Enter table name"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Total Rows
                    </label>
                    <div className="px-3 py-2 bg-gray-100 dark:bg-gray-600 rounded-md text-gray-900 dark:text-white">
                      {preview.totalRows.toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>

              {/* Column Schema */}
              <div>
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-3">
                  Column Schema (Auto-detected)
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium text-gray-900 dark:text-white">Column</th>
                        <th className="px-3 py-2 text-left font-medium text-gray-900 dark:text-white">Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {preview.columns.map((column) => (
                        <tr key={column} className="bg-white dark:bg-gray-800">
                          <td className="px-3 py-2 font-mono text-gray-900 dark:text-white">{column}</td>
                          <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{preview.inferredTypes[column]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Data Preview */}
              <div>
                <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-3">
                  Data Preview (First 5 rows)
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg">
                    <thead className="bg-gray-50 dark:bg-gray-700">
                      <tr>
                        {preview.columns.map((column) => (
                          <th key={column} className="px-3 py-2 text-left font-medium text-gray-900 dark:text-white">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {preview.sampleRows.map((row, index) => (
                        <tr key={index} className="bg-white dark:bg-gray-800">
                          {preview.columns.map((column) => (
                            <td key={column} className="px-3 py-2 text-gray-900 dark:text-white">
                              {row[column] === null ? (
                                <span className="text-gray-400 italic">NULL</span>
                              ) : (
                                String(row[column])
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={handleFileSelect}
            className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            disabled={isImporting}
          >
            Choose Different File
          </button>

          <div className="flex gap-2">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
              disabled={isImporting}
            >
              Cancel
            </button>
            {preview && (
              <button
                onClick={handleImport}
                disabled={!tableName.trim() || isImporting || !!importResult?.success}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-400 text-white rounded-lg transition-colors"
              >
                {isImporting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                    Importing...
                  </>
                ) : (
                  <>
                    <Database size={16} />
                    Import Data
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>
    </div>
  );
};
