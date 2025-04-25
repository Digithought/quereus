// Re-export from types for potentially wider use
export { StatusCode, SqlDataType } from './types';

// Placeholder for VDBE Opcodes (will expand significantly)
export enum Opcode {
	Init = 1,
	Goto = 2,
	Halt = 0,
	Noop = 145,

	// Data loading/constants
	Null = 11,
	Integer = 6,
	Int64 = 118,
	String8 = 119,
	Real = 117,
	Blob = 40,
	ZeroBlob = 146, // Keep higher number

	// Register Manipulation
	SCopy = 22,
	Move = 21,
	Clear = 20,

	// Control Flow / Jumps
	IfTrue = 31,
	IfFalse = 32,
	IfZero = 33,
	IfNull = 34,
	IfNotNull = 35,
	IsNull = 29,
	NotNull = 30,
	Eq = 23,
	Ne = 24,
	Lt = 25,
	Le = 26,
	Gt = 27,
	Ge = 28,
	Once = 14,
	IfPos = 97, // Renumbered from 117
	IfNeg = 98, // Renumbered from 118

	// Arithmetic/Logic
	Add = 36,
	Subtract = 37,
	Multiply = 38,
	Divide = 39,
	Remainder = 40,
	Concat = 41,

	// Bitwise / Unary
	Negative = 42,
	BitAnd = 43,
	BitOr = 44,
	ShiftLeft = 45,
	ShiftRight = 46,
	BitNot = 47,
	Not = 88, // Keep 88

	// Type Affinity / Conversion
	Affinity = 57,

	// Ephemeral Table Opcodes
	OpenEphemeral = 60,
	Rewind = 62,
	MakeRecord = 51,
	IdxInsert = 123, // Keep 123

	// Functions
	Function = 48,

	// Cursors / VTable
	OpenRead = 58,
	OpenWrite = 59,
	Close = 61,
	VFilter = 66,
	VNext = 63,
	VColumn = 64,
	VUpdate = 67,
	VRowid = 65,
	VBegin = 69,
	VCommit = 70,
	VRollback = 71,
	VSync = 72,
	VSavepoint = 73,
	VRelease = 74,
	VRollbackTo = 75,
	ConstraintViolation = 87,

	// Results
	ResultRow = 76,

	// Sorting
	Sort = 68,
	Sorted = 115, // Keep 115

	// Subroutines & Frame Management
	Subroutine = 90,
	Return = 91,
	FrameEnter = 88,
	FrameLeave = 89,
	Push = 92,
	StackPop = 93,

	// Aggregation Opcodes
	AggStep = 49,
	AggFinal = 50,
	AggIterate = 52,
	AggNext = 53,
	AggKey = 54,
	AggContext = 55,
	AggGroupValue = 56,

	// Misc
	CollSeq = 120, // Keep 120
	OpenPseudo = 121, // Keep 121
	Next = 124, // Keep 124
	VerifyCookie = 107, // Keep 107
	Savepoint = 141,

	// Frame Opcodes
	SeekRelative = 94,
	SeekRowid = 95,
	Checkpoint = 167,   // Checkpoint database P1
	WalCheckpoint = 167, // Deprecated: Use Checkpoint

	// DDL/Schema Opcodes
	SchemaInvalidate = 168, // Invalidate schema cache
	SchemaLoad = 169, // Load schema (used internally)
	CreateIndex = 80,
	CreateTable = 81,
	CreateView = 85,
	DropTable = 82,
	DropIndex = 83,
	DropView = 84,
	AlterTable = 104,
	SchemaChange = 86,

	// Window Function Opcodes
	AggReset = 103,

} // End Opcode Enum

// Constants for function flags (matching C API where sensible)
export enum FunctionFlags {
	UTF8 = 1,
	// UTF16LE = 2, // Decide if UTF16 support is needed internally
	// UTF16BE = 3,
	// UTF16 = 4,
	DETERMINISTIC = 0x000000800,
	DIRECTONLY = 0x000080000,
	INNOCUOUS = 0x000200000,
	// Add others if needed (SUBTYPE, etc.)
}

// Constants for VTable configuration
export enum VTabConfig {
	CONSTRAINT_SUPPORT = 1,
	INNOCUOUS = 2,
	DIRECTONLY = 3,
	USES_ALL_SCHEMAS = 4,
}

// Constants for VTable constraint operators
export enum IndexConstraintOp {
	EQ = 2,
	GT = 4,
	LE = 8,
	LT = 16,
	GE = 32,
	MATCH = 64,
	LIKE = 65, // Requires a LIKE implementation or delegation
	GLOB = 66, // Requires a GLOB implementation or delegation
	REGEXP = 67, // Requires a REGEXP implementation or delegation
	NE = 68,
	ISNOT = 69,
	ISNOTNULL = 70,
	ISNULL = 71,
	IS = 72,
	LIMIT = 73,
	OFFSET = 74,
	FUNCTION = 150, // Base for function-based constraints
}

// Constants for Conflict Resolution (matching C API)
export enum ConflictResolution {
	ROLLBACK = 1,
	ABORT = 4, // Note: Also a status code
	FAIL = 3,
	IGNORE = 2, // Note: Also used elsewhere
	REPLACE = 5,
}

// Constants for Changeset operations (matching C API)
export enum ChangesetOperation {
	DELETE = 9,
	INSERT = 18,
	UPDATE = 23,
}
