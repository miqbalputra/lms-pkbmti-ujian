package main

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Base struct {
	ID        string    `gorm:"primaryKey" json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (b *Base) BeforeCreate(*gorm.DB) error {
	if b.ID == "" {
		b.ID = uuid.NewString()
	}
	return nil
}

type CBTAccount struct {
	Base
	SourceUserID    string `gorm:"uniqueIndex" json:"sourceUserId"`
	Username        string `gorm:"uniqueIndex;not null" json:"username"`
	PasswordHash    string `json:"-"`
	Nama            string `json:"nama"`
	Role            string `gorm:"index;not null" json:"role"`
	PesertaDidikID  string `gorm:"index" json:"pesertaDidikId,omitempty"`
	TutorID         string `gorm:"index" json:"tutorId,omitempty"`
	Active          bool   `gorm:"index;default:true" json:"active"`
	SourceUpdatedAt int64  `json:"sourceUpdatedAt"`
}

type MasterKelas struct {
	Base
	Nama            string `json:"nama"`
	Jenjang         int    `json:"jenjang"`
	Active          bool   `gorm:"index;default:true" json:"active"`
	SourceUpdatedAt int64  `json:"sourceUpdatedAt"`
}
type MasterPeserta struct {
	Base
	Nama            string `json:"nama"`
	NISN            string `gorm:"uniqueIndex" json:"nisn"`
	KelasID         string `gorm:"index" json:"kelasId"`
	Active          bool   `gorm:"index;default:true" json:"active"`
	SourceUpdatedAt int64  `json:"sourceUpdatedAt"`
}
type MasterTutor struct {
	Base
	Nama            string `json:"nama"`
	Active          bool   `gorm:"index;default:true" json:"active"`
	SourceUpdatedAt int64  `json:"sourceUpdatedAt"`
}
type MasterMapel struct {
	Base
	Nama            string `json:"nama"`
	Kode            string `json:"kode"`
	Active          bool   `gorm:"index;default:true" json:"active"`
	SourceUpdatedAt int64  `json:"sourceUpdatedAt"`
}

type Question struct {
	Base
	OwnerID     string     `gorm:"index" json:"ownerId"`
	Title       string     `json:"title"`
	Type        string     `gorm:"index" json:"type"`
	Prompt      string     `gorm:"type:text" json:"prompt"`
	Description string     `gorm:"type:text" json:"description"`
	ConfigJSON  string     `gorm:"type:text" json:"configJson"`
	AnswerJSON  string     `gorm:"type:text" json:"answerJson"`
	RubricJSON  string     `gorm:"type:text" json:"rubricJson,omitempty"`
	Points      float64    `json:"points"`
	Status      string     `gorm:"index" json:"status"`
	ArchivedAt  *time.Time `json:"archivedAt,omitempty"`
}

type Assessment struct {
	Base
	OwnerID        string     `gorm:"index" json:"ownerId"`
	Kind           string     `gorm:"index" json:"kind"`
	Title          string     `json:"title"`
	Description    string     `gorm:"type:text" json:"description"`
	ClassID        string     `gorm:"index" json:"classId"`
	SubjectID      string     `gorm:"index" json:"subjectId"`
	Status         string     `gorm:"index" json:"status"`
	AccessCodeHash string     `json:"-"`
	DurationMinute int        `json:"durationMinute"`
	StartsAt       *time.Time `json:"startsAt,omitempty"`
	EndsAt         *time.Time `json:"endsAt,omitempty"`
	Randomize      bool       `json:"randomize"`
	ShowResult     bool       `json:"showResult"`
	Revision       int        `json:"revision"`
}

type AssessmentItem struct {
	Base
	AssessmentID string  `gorm:"index:assessment_item_order" json:"assessmentId"`
	QuestionID   string  `gorm:"index" json:"questionId"`
	Position     int     `gorm:"index:assessment_item_order" json:"position"`
	Weight       float64 `json:"weight"`
	SnapshotJSON string  `gorm:"type:text" json:"snapshotJson"`
}
type AssessmentAssignment struct {
	Base
	AssessmentID string `gorm:"uniqueIndex:assessment_assignment" json:"assessmentId"`
	StudentID    string `gorm:"uniqueIndex:assessment_assignment;index" json:"studentId"`
}
type Attempt struct {
	Base
	AssessmentID     string     `gorm:"uniqueIndex:assessment_student_number,priority:1;index" json:"assessmentId"`
	StudentID        string     `gorm:"uniqueIndex:assessment_student_number,priority:2;index" json:"studentId"`
	ClassIDAtAttempt string     `gorm:"index" json:"classIdAtAttempt"`
	Number           int        `gorm:"uniqueIndex:assessment_student_number,priority:3" json:"number"`
	Status           string     `gorm:"index" json:"status"`
	Seed             string     `json:"seed"`
	StartedAt        *time.Time `json:"startedAt,omitempty"`
	SubmittedAt      *time.Time `json:"submittedAt,omitempty"`
	DeadlineAt       *time.Time `json:"deadlineAt,omitempty"`
	Score            float64    `json:"score"`
	NeedsManual      bool       `json:"needsManual"`
	SourceAttemptID  string     `gorm:"uniqueIndex" json:"sourceAttemptId,omitempty"`
}
type AttemptItem struct {
	Base
	AttemptID        string  `gorm:"uniqueIndex:attempt_item_order,priority:1;index" json:"attemptId"`
	AssessmentItemID string  `gorm:"index" json:"assessmentItemId"`
	QuestionID       string  `gorm:"index" json:"questionId"`
	Position         int     `gorm:"uniqueIndex:attempt_item_order,priority:2" json:"position"`
	Weight           float64 `json:"weight"`
	SnapshotJSON     string  `gorm:"type:text" json:"snapshotJson"`
	Flagged          bool    `json:"flagged"`
}
type Answer struct {
	Base
	AttemptID     string   `gorm:"uniqueIndex:answer_attempt_item,priority:1;index" json:"attemptId"`
	AttemptItemID string   `gorm:"uniqueIndex:answer_attempt_item,priority:2;index" json:"attemptItemId"`
	ValueJSON     string   `gorm:"type:text" json:"valueJson"`
	Correct       *bool    `json:"correct,omitempty"`
	AutoScore     float64  `json:"autoScore"`
	ManualScore   *float64 `json:"manualScore,omitempty"`
	Comment       string   `gorm:"type:text" json:"comment,omitempty"`
	Revision      int      `json:"revision"`
}

type AuditLog struct {
	Base
	ActorID  string `gorm:"index" json:"actorId"`
	Action   string `gorm:"index" json:"action"`
	Resource string `gorm:"index" json:"resource"`
	Detail   string `gorm:"type:text" json:"detail"`
}
type SyncState struct {
	Key       string    `gorm:"primaryKey" json:"key"`
	Value     string    `gorm:"type:text" json:"value"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type IntegrationNonce struct {
	Nonce     string    `gorm:"primaryKey"`
	ExpiresAt time.Time `gorm:"index"`
}
type IntegrationOutbox struct {
	Base
	EventID       string     `gorm:"uniqueIndex" json:"eventId"`
	Type          string     `gorm:"index" json:"type"`
	PayloadJSON   string     `gorm:"type:text" json:"-"`
	Attempts      int        `json:"attempts"`
	NextAttemptAt time.Time  `gorm:"index" json:"nextAttemptAt"`
	DeliveredAt   *time.Time `json:"deliveredAt,omitempty"`
	LastError     string     `gorm:"type:text" json:"lastError,omitempty"`
}
type MigrationBatch struct {
	Base
	SourceBatchID string     `gorm:"uniqueIndex" json:"sourceBatchId"`
	Status        string     `gorm:"index" json:"status"`
	SummaryJSON   string     `gorm:"type:text" json:"summaryJson"`
	ErrorText     string     `gorm:"type:text" json:"errorText,omitempty"`
	FinishedAt    *time.Time `json:"finishedAt,omitempty"`
}
