// Re-export from types for potentially wider use
export { StatusCode, SqlDataType } from './types';

// Placeholder for VDBE Opcodes (will expand significantly)
export enum Opcode {
	Init = 1,
	Goto = 2,
	Halt = 0,
	Noop = 145,

	// Data loading/constants
	Null = 11,      // P2=reg; Set reg P2 to NULL
	Integer = 6,    // P1=value, P2=reg; Set reg P2 to integer P1
	Int64 = 118,    // P4=int64_const_idx, P2=reg; Set reg P2 to P4
	String8 = 119,  // P2=reg, P4=string_const_idx; Set reg P2 to string P4
	Real = 117,     // P4=double_const_idx, P2=reg; Set reg P2 to P4
	Blob = 40,      // P1=len?, P2=reg, P4=blob_const_idx; Set reg P2 to P4
	ZeroBlob = 146, // P1=reg_size, P2=reg_dest; Create zeroblob in R[P2] size R[P1]

	// Register Manipulation
	SCopy = 9,      // P1=src, P2=dest; Copy R[P1] to R[P2]
	Move = 12,      // P1=src, P2=dest, P3=count; Move R[P1..P1+P3-1] to R[P2..P2+P3-1]
	Clear = 10,     // P1=start_reg, P2=count; Clear R[P1]..R[P1+P2-1] to NULL

	// Control Flow / Jumps
	IfTrue = 15,    // P1=reg, P2=addr; if R[P1] then jump to P2
	IfFalse = 16,   // P1=reg, P2=addr; if R[P1] is false then jump to P2
	IfZero = 93,    // P1=reg, P2=addr; if R[P1]==0 or NULL jump to P2
	IfNull = 17,    // P1=reg, P2=addr; if R[P1] is NULL jump to P2
	IfNotNull = 18, // P1=reg, P2=addr; if R[P1] is NOT NULL jump to P2
	IsNull = 8,     // P1=reg, P2=dest; R[P2]=1 if R[P1] is NULL
	NotNull = 10,   // P1=reg, P2=dest; R[P2]=1 if R[P1] is not NULL
	Eq = 76,        // P1=reg1, P2=addr, P3=reg2; if R[P1]==R[P3] goto P2
	Ne = 75,        // P1=reg1, P2=addr, P3=reg2; if R[P1]!=R[P3] goto P2
	Lt = 77,        // P1=reg1, P2=addr, P3=reg2; if R[P1]< R[P3] goto P2
	Le = 78,        // P1=reg1, P2=addr, P3=reg2; if R[P1]<=R[P3] goto P2
	Gt = 79,        // P1=reg1, P2=addr, P3=reg2; if R[P1]> R[P3] goto P2
	Ge = 80,        // P1=reg1, P2=addr, P3=reg2; if R[P1]>=R[P3] goto P2
	Once = 14,      // P1=reg_flag, P2=addr_jump; If R[P1]++, jump to P2

	// Arithmetic/Logic
	Add = 67,       // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P1] + R[P2]
	Subtract = 68,  // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P2] - R[P1] (Order matters!)
	Multiply = 69,  // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P1] * R[P2]
	Divide = 70,    // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P2] / R[P1]
	Remainder = 71, // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P2] % R[P1]
	Concat = 72,    // P1=firstReg, P2=lastReg, P3=dest; Concatenate R[P1]..R[P2] -> R[P3]

	// Bitwise / Unary
	Negative = 73,  // P1=reg_src, P2=reg_dest; R[P2] = -R[P1]
	// TODO: BitNot, ShiftLeft, ShiftRight if needed
	BitAnd = 74,    // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P1] & R[P2]
	BitOr = 84,     // P1=reg1, P2=reg2, P3=dest; R[P3] = R[P1] | R[P2] (Opcode reuse? Check SQLite)
	ShiftLeft = 85, // P1=reg1(Amount), P2=reg2(Value), P3=dest; R[P3] = R[P2] << R[P1]
	ShiftRight = 86,// P1=reg1(Amount), P2=reg2(Value), P3=dest; R[P3] = R[P2] >> R[P1]
	BitNot = 87,    // P1=reg_src, P2=reg_dest; R[P2] = ~R[P1]

	// Type Affinity / Conversion
	Affinity = 91,  // P1=reg_start, P2=count, P3=0, P4=affinity_string; Apply affinity P4 to R[P1..P1+P2-1]

	// Ephemeral Table Opcodes (for Subqueries, Temp Tables)
	OpenEphemeral = 5, // P1=cursorIdx, P2=numCols; Create temp B-Tree table
	Rewind = 7,      // P1=cursorIdx, P2=addrIfEmpty; Position cursor P1 at start
	MakeRecord = 83,  // P1=firstReg, P2=count, P3=destReg (Create serialized key for GROUP BY)
	// Insert = ?,      // P1=cursor, P2=regRecord, P3=regRowidDest? Use VUpdate instead?

	// Functions
	Function = 89,  // P1=reg_func, P2=reg_first_arg, P3=reg_result, P4=P4FuncDef

	// Cursors / VTable
	OpenRead = 58,  // P1=cursorIdx, P2=0, P3=dbIdx, P4=TableSchema Ptr
	OpenWrite = 59, // P1=cursorIdx, P2=numCols, P3=dbIdx, P4=TableSchema Ptr (Needed for VUpdate?)
	Close = 57,     // P1=cursorIdx; Close the specified cursor
	VFilter = 166,  // P1=cursorIdx, P2=addrNoRow, P3=regArgsStart, P4={idxNum, idxStr, nArgs}
	VNext = 167,    // P1=cursorIdx, P2=addrEOF
	VColumn = 88,   // P1=cursorIdx, P2=colIdx, P3=destReg
	VUpdate = 168,  // P1=nData, P2=regDataStart, P3=cursorIdx, P4=P4KeyInfo?
	VRowid = 169,   // P1=cursorIdx, P2=destReg; Get rowid from cursor P1
	VBegin = 170,   // P1=cursorIdx (or 0 for all?)
	VCommit = 171,  // P1=cursorIdx (or 0 for all?)
	VRollback = 172,// P1=cursorIdx (or 0 for all?)
	VSync = 173,    // P1=cursorIdx (or 0 for all?)

	// Results
	ResultRow = 81, // P1=reg_first, P2=count; Output row from R[P1]..R[P1+P2-1]

	// Sorting
	Sort = 130,     // P1=cursorIdx, P2=addrEnd?, P4=SortKeyInfo? Sort ephemeral table P1

	// Subroutines (for Correlated Subqueries etc.)
	Subroutine = 131, // P1=reg_RetAddr, P2=addr_Target
	Return = 132,     // P1=reg_RetAddr

	// Aggregation Opcodes
	AggStep = 133,    // P1=regGroupKeyStart, P2=firstArgReg, P3=regSerializedKey, P4=P4FuncDef, P5=numGroupKeys
	AggFinal = 134,   // P1=regAccKey?, P3=resultReg, P4=P4FuncDef   // Finalize aggregate

	// Grouping / Aggregate Iteration
	AggReset = 135,   // Clear VDBE aggregate context map
	AggIterate = 136, // P1=mapIteratorReg. Start iteration over aggregate map.
	AggNext = 137,    // P1=mapIteratorReg, P2=addrEOF. Advance iterator.
	AggKey = 138,     // P1=mapIteratorReg, P2=destReg. Get current group key (serialized?).
	AggContext = 139, // P1=mapIteratorReg, P2=destReg. Get current aggregate context object.
	AggGroupValue = 140, // P1=mapIteratorReg, P2=keyIndex, P3=destReg. Get specific original group key value.

	// Savepoint Opcodes
	Savepoint = 141, // P1=0, P2=SavepointOperation, P4=SavepointName
	// Note: Reusing VBegin/VCommit/VRollback for VTab hooks, need distinct opcodes for SAVEPOINT actions
	VSavepoint = 174, // P1=Savepoint Index/ID?
	VRelease = 175,   // P1=Savepoint Index/ID?
	VRollbackTo = 176,// P1=Savepoint Index/ID?

	// Frame Management (New)
	FrameEnter = 180,  // P1=FrameSize (num locals)
	FrameLeave = 181,  // P1=Return Address Reg
	LoadOuterVar = 182,// P1=OuterFrameLevels, P2=VarIndexInOuterFrame, P3=DestReg
	Push = 183,        // P1=SrcRegOffset (Value to push)
	StackPop = 184,    // P1=Count (Number of items to pop from absolute stack top)

	// Other (Placeholder codes, need verification)
	// Count = 84,
	IfNullRow = 11, // P1=cursorIdx, P2=addr; If cursor P1 is on a NULL row (LEFT JOIN), jump to P2
	// Transaction Control (Using VBegin/VCommit/VRollback for VTabs, need distinct opcodes)
	Transaction = 190, // P1=0(BEGIN)/1(COMMIT)/2(ROLLBACK)
}

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

