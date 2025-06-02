import React from 'react';

export const LoadingSplash: React.FC = () => {
	return (
		<div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900 transition-colors duration-300">
			<div className="text-center max-w-lg mx-auto px-6">
				{/* Quoomb Logo */}
				<div className="flex justify-center mb-12">
					<img
						src="/quoomb-logo-horizontal.svg"
						alt="Quoomb - Quereus SQL Playground"
						className="h-20 w-auto animate-pulse"
						style={{ filter: 'var(--logo-filter, none)' }}
					/>
				</div>

				{/* Loading text and spinner */}
				<div className="flex items-center justify-center gap-3 mb-6">
					<div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
					<p className="text-lg font-medium text-gray-700 dark:text-gray-300">
						Initializing Quereus Engine...
					</p>
				</div>

				{/* Subtitle */}
				<p className="text-sm text-gray-500 dark:text-gray-400">
					SQL Playground for In-Memory Data Processing
				</p>

				{/* Progress dots */}
				<div className="flex justify-center gap-2 mt-8">
					<div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
					<div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></div>
					<div className="w-2 h-2 bg-blue-300 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></div>
				</div>
			</div>
		</div>
	);
};