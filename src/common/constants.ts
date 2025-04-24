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
	SCopy = 9,
	Move = 12,
	Clear = 10, // Renumbered from 111 to avoid conflict

	// Control Flow / Jumps
	IfTrue = 15,
	IfFalse = 16,
	IfZero = 93,
	IfNull = 17,
	IfNotNull = 18, // Reassigned from 10? Let's keep 18
	IsNull = 8,
	NotNull = 19, // Was 10, but Clear is 10. Also conflicts with IfNotNull if 18 is used. Needs careful review. Let's try 19.
	Eq = 76,
	Ne = 75,
	Lt = 77,
	Le = 78,
	Gt = 79,
	Ge = 80,
	Once = 14,
	IfPos = 97, // Renumbered from 117
	IfNeg = 98, // Renumbered from 118

	// Arithmetic/Logic
	Add = 67,
	Subtract = 68,
	Multiply = 69,
	Divide = 70,
	Remainder = 71,
	Concat = 72,

	// Bitwise / Unary
	Negative = 73,
	BitAnd = 74,
	BitOr = 84,
	ShiftLeft = 85,
	ShiftRight = 86,
	BitNot = 87,
	Not = 88, // Keep 88

	// Type Affinity / Conversion
	Affinity = 91,

	// Ephemeral Table Opcodes
	OpenEphemeral = 5,
	Rewind = 7,
	MakeRecord = 83,
	IdxInsert = 123, // Keep 123

	// Functions
	Function = 108, // Keep 108

	// Cursors / VTable
	OpenRead = 58,
	OpenWrite = 59,
	Close = 159,
	VFilter = 166,
	VNext = 167,
	VColumn = 192, // Reassigned from 88 to avoid conflict with Not
	VUpdate = 168,
	VRowid = 169,
	VBegin = 170,
	VCommit = 171,
	VRollback = 172,
	VSync = 173,
	VSavepoint = 174,
	VRelease = 175,
	VRollbackTo = 176,
	ConstraintViolation = 180, // P4=Error Context String

	// Results
	ResultRow = 81,

	// Sorting
	Sort = 130,
	Sorted = 115, // Keep 115

	// Subroutines & Frame Management
	Subroutine = 133, // Keep 133
	Return = 134, // Keep 134
	FrameEnter = 135, // Keep 135
	FrameLeave = 136, // Keep 136
	// LoadOuterVar = 182, // TODO: Implement if needed for correlation
	Push = 131, // Keep 131
	StackPop = 132, // Keep 132

	// Aggregation Opcodes
	AggStep = 109, // Keep 109
	AggFinal = 110, // Keep 110
	AggIterate = 126, // Keep 126
	AggNext = 127, // Keep 127
	AggKey = 128, // Keep 128
	AggContext = 129, // Keep 129
	AggGroupValue = 140, // Reassigned from 130 to avoid conflict with Sort

	// Misc
	CollSeq = 120, // Keep 120
	OpenPseudo = 121, // Keep 121
	Next = 124, // Keep 124
	VerifyCookie = 107, // Keep 107
	Savepoint = 141,
	// ConfigureSorter=185, // TODO: Review/renumber

	// Remove placeholders/unused
	// Transaction = 190, // Replaced by VBegin/VCommit/etc.
	// IfNullRow = 11, // Conflicts with Null

	// Frame Opcodes
	SeekRel = 160,      // p1=cursor, p2=targetReg, p3=basePtrReg, p4=offsetReg, p5=direction(-1/+1). Result ptr in p2.
	MaxPtr = 161,       // p1=ptrRegA, p2=ptrRegB, p3=targetReg. Store Max(p1,p2) in p3.
	AggFrame = 162,     // p1=cursor, p2=resultReg, p3=frameStartPtrReg, p4=P5AggFrameInfo, p5=frameEndPtrReg
	FrameValue = 163,   // p1=cursor, p2=resultReg, p3=ptrReg, p4=argColIdx.
	RangeScan = 164,    // p1=cursor, p2=startPtrReg, p3=endPtrReg, p4=P4RangeScanInfo { frameDef, orderByIndices, orderByDirs, orderByColls, currPtrReg, partStartPtrReg, startBoundReg?, endBoundReg? }
	Lag = 165,          // p1=cursor, p2=targetReg, p3=offsetReg, p4=P4LagLeadInfo { currRowPtrReg, argColIdx }, p5=defaultReg
	Lead = 166,         // p1=cursor, p2=targetReg, p3=offsetReg, p4=P4LagLeadInfo { currRowPtrReg, argColIdx }, p5=defaultReg
	Checkpoint = 167,   // Checkpoint database P1
	WalCheckpoint = 167, // Deprecated: Use Checkpoint

	// DDL/Schema Opcodes
	SchemaInvalidate = 168, // Invalidate schema cache
	SchemaLoad = 169, // Load schema (used internally)
	CreateIndex = 170, // Arguments = P4_INDEXDEF
	CreateTable = 171, // Arguments = P4_TABLEDEF
	CreateView = 172,  // Arguments = P4_VIEWDEF
	DropTable = 173,
	DropIndex = 174,
	DropView = 175,
	AlterTable = 176, // Placeholder for complex ALTER, maybe unused
	SchemaChange = 177, // Perform VTab schema change (ADD/DROP/RENAME COL), P4=P4_SCHEMACHANGE

	// Window Function Opcodes
	AggReset = 178,    // Reset aggregate context P1=regCtx P2=nArg

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
