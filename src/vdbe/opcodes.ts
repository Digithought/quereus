// These must be < 256 unless you update handlers.ts
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
	ZeroBlob = 146,// Keep higher number

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
	IfPos = 97,
	IfNeg = 98,

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
	Not = 88,

	// Type Affinity / Conversion
	Affinity = 57,

	// Ephemeral Table Opcodes
	OpenEphemeral = 60,
	Rewind = 62,
	MakeRecord = 51,
	IdxInsert = 123,

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

	// --- Add new VTab DDL opcodes --- //
	VCreateIndex = 170, // Arbitrary high number
	VDropIndex = 171,   // Arbitrary high number
	// -------------------------------- //

	// Results
	ResultRow = 76,

	// Sorting
	Sort = 68,

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
	AggContext = 152,
	AggGroupValue = 153,
	AggGetContext = 154,
	AggGetAccumulatorByKey = 155,

	// Misc
	CollSeq = 120,
	OpenPseudo = 121,
	Next = 124,
	VerifyCookie = 107,
	Savepoint = 141,

	// Frame Opcodes
	SeekRelative = 94,
	SeekRowid = 95,
	Checkpoint = 167,

	// DDL/Schema Opcodes
	SchemaInvalidate = 168,
	SchemaLoad = 169,
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

	// New opcodes
	OpenTvf = 105,

	// --- Window Functions --- //
	WindowSort = 160, // Sort the window ephemeral table

} // End Opcode Enum

