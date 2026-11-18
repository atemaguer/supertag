//! One explicitly advertised Objective tool. Native input never supplies an
//! Attempt identity or an operator credential; the private bridge supplies it.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};
use supertag_protocol::{
    MAX_MESSAGE_BYTES,
    v2::{
        AttemptCapabilities, HarnessAskQuestionRequest, ObjectiveSignal,
        harness_artifacts_client::HarnessArtifactsClient,
        harness_questions_client::HarnessQuestionsClient,
    },
};
use tonic::{Code, transport::Channel};

use crate::coordination::{self, Arguments, Inventory};

pub(crate) const NONE: &str = "none-v1";
pub(crate) const OBJECTIVE_ASK: &str = "objective-ask-text-v1";
pub(crate) const FULL_COORDINATION: &str = "coordination-v1";
pub(crate) const DIRECT_COORDINATION: &str = "coordination-v2";
pub(crate) const WORK_SESSIONS: &str = "coordination-v3";
pub(crate) const WORK_SESSION_LIFECYCLE: &str = "coordination-v4";
pub(crate) const DIRECT_REVIEW: &str = "coordination-v2-review-v1";
pub(crate) const WORK_SESSIONS_REVIEW: &str = "coordination-v3-review-v1";
pub(crate) const WORK_SESSION_LIFECYCLE_REVIEW: &str = "coordination-v4-review-v1";
pub(crate) const CHILD_QUESTIONS: &str = "work-session-ask-v1";
pub(crate) const ARTIFACT_ACQUIRE_SUFFIX: &str = "+artifact-acquire-v1";
pub(crate) const ARTIFACT_ATTACH_SUFFIX: &str = "+artifact-attach-v1";
pub(crate) const ARTIFACT_CAPTURE_SUFFIX: &str = "+artifact-capture-v1";
pub(crate) const TAG_SESSIONS_SUFFIX: &str = "+tag-sessions-v2";
pub(crate) const OWN_SESSION_SUFFIX: &str = "+own-session-v1";
pub(crate) const SCHEDULE_SUFFIX: &str = "+schedule-v1";
pub(crate) const CLOSE_SESSION_SUFFIX: &str = "+close-session-v1";
pub(crate) const MEMORY_SUFFIX: &str = "+memory-v1";
pub(crate) const QUIET_SUFFIX: &str = "+quiet-v1";
pub(crate) const OBJECTIVE_REPORT_SUFFIX: &str = "+objective-report-v1";
pub(crate) const ONGOING_OBJECTIVE_REPORT_SUFFIX: &str = "+objective-report-ongoing-v1";
const ONGOING_COMPLETION_REFUSED: &str = "This Objective is ongoing, so it never completes; only an operator ends it. Report ready_for_review or blocked instead, or finish the turn without a report.";
const REPORT_SUMMARY_MAX: usize = 16_000;
const QUIET_NOTE_MAX: usize = 500;

#[derive(Clone, Copy)]
pub(crate) struct Tools {
    pub(crate) coordination: Inventory,
    pub(crate) capture_artifact: bool,
    pub(crate) acquire_artifacts: bool,
    pub(crate) attach_artifacts: bool,
    /// `list_sessions`, `search_sessions`, `read_session`, `read_turn`, `list_objectives`, and
    /// `read_objective` for a root turn; `read_session` and `read_turn` of its own Session for a
    /// Work Session's own Task.
    pub(crate) tag_sessions: crate::tag_sessions::Reads,
    /// `schedule` and `cancel_schedule`, for a root turn.
    pub(crate) schedule: bool,
    /// `close_session`, with `start_session`.
    pub(crate) close_sessions: bool,
    /// `remember` and `forget`, for a root turn of a Tag that keeps memory.
    pub(crate) memory: bool,
    /// `stay_quiet`, for a turn no person is waiting on.
    pub(crate) quiet: bool,
    /// `report_objective`, for the owner Session of an open Objective.
    pub(crate) report_objective: Reporting,
}

/// Whether a turn offers `report_objective`, and which statuses it offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Reporting {
    None,
    /// `ready_for_review`, `completed`, or `blocked`.
    Finishing,
    /// An ongoing Objective never completes: `ready_for_review` or `blocked`.
    Ongoing,
}

impl Reporting {
    pub(crate) fn new(capabilities: &AttemptCapabilities) -> Self {
        match (
            capabilities.may_ask_objective_question,
            capabilities.objective_ongoing,
        ) {
            (false, _) => Self::None,
            (true, false) => Self::Finishing,
            (true, true) => Self::Ongoing,
        }
    }

    pub(crate) fn offered(self) -> bool {
        self != Self::None
    }

    pub(crate) fn suffix(self) -> &'static str {
        match self {
            Self::None => "",
            Self::Finishing => OBJECTIVE_REPORT_SUFFIX,
            Self::Ongoing => ONGOING_OBJECTIVE_REPORT_SUFFIX,
        }
    }
}

/// The status an Objective's owner reported during this turn. It applies only when the
/// turn succeeds without waiting for an answer or an approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ObjectiveReport {
    pub(crate) signal: ObjectiveSignal,
    pub(crate) summary: String,
}

impl Tools {
    pub(crate) fn enabled(self) -> bool {
        self.coordination != Inventory::None
            || self.capture_artifact
            || self.acquire_artifacts
            || self.tag_sessions.offered()
            || self.schedule
            || self.close_sessions
            || self.memory
            || self.quiet
            || self.report_objective.offered()
    }

    /// Names the tools a native thread registers. A checkpointed thread resumes only with the
    /// same manifest; otherwise the turn starts a fresh thread that registers today's tools.
    pub(crate) fn manifest(self) -> String {
        let base = match self.coordination {
            Inventory::None => NONE,
            Inventory::Ask => OBJECTIVE_ASK,
            Inventory::ChildQuestions => CHILD_QUESTIONS,
            Inventory::Workstream => FULL_COORDINATION,
            Inventory::Direct => DIRECT_COORDINATION,
            Inventory::DirectReview => DIRECT_REVIEW,
            Inventory::WorkSessions => WORK_SESSIONS,
            Inventory::WorkSessionsReview => WORK_SESSIONS_REVIEW,
            Inventory::WorkSessionLifecycle => WORK_SESSION_LIFECYCLE,
            Inventory::WorkSessionLifecycleReview => WORK_SESSION_LIFECYCLE_REVIEW,
        };
        let mut manifest = base.to_owned();
        if self.capture_artifact {
            manifest.push_str(ARTIFACT_CAPTURE_SUFFIX);
        }
        if self.acquire_artifacts {
            manifest.push_str(ARTIFACT_ACQUIRE_SUFFIX);
        }
        if self.attach_artifacts {
            manifest.push_str(ARTIFACT_ATTACH_SUFFIX);
        }
        match self.tag_sessions {
            crate::tag_sessions::Reads::None => {}
            crate::tag_sessions::Reads::Own => manifest.push_str(OWN_SESSION_SUFFIX),
            crate::tag_sessions::Reads::All => manifest.push_str(TAG_SESSIONS_SUFFIX),
        }
        if self.schedule {
            manifest.push_str(SCHEDULE_SUFFIX);
        }
        if self.close_sessions {
            manifest.push_str(CLOSE_SESSION_SUFFIX);
        }
        if self.memory {
            manifest.push_str(MEMORY_SUFFIX);
        }
        if self.quiet {
            manifest.push_str(QUIET_SUFFIX);
        }
        manifest.push_str(self.report_objective.suffix());
        manifest
    }

    pub(crate) fn arguments(self, params: &Value) -> Result<Arguments> {
        if params["tool"] == "capture_artifact" && self.capture_artifact {
            return Ok(Arguments::Capture(crate::artifact::Capture::parse(params)?));
        }
        if (matches!(
            params["tool"].as_str(),
            Some("find_artifacts" | "inspect_artifact" | "read_artifact")
        ) && self.acquire_artifacts)
            || (params["tool"] == "attach_artifact" && self.attach_artifacts)
        {
            return Ok(Arguments::Acquire(crate::artifact::Acquisition::parse(
                params,
            )?));
        }
        if params["tool"] == "report_objective" && self.report_objective.offered() {
            return Ok(Arguments::Report(validate_report(params)?));
        }
        if params["tool"] == "stay_quiet" && self.quiet {
            return Ok(Arguments::Quiet(validate_quiet(params)?));
        }
        if self.close_sessions
            && let Some(id) = coordination::close_arguments(params)?
        {
            return Ok(Arguments::CloseSession(id));
        }
        if self.schedule
            && params["namespace"] == "supertag"
            && let Some(call) = crate::schedules::arguments(params)?
        {
            return Ok(Arguments::Schedule(call));
        }
        if self.memory
            && params["namespace"] == "supertag"
            && let Some(call) = crate::memory::arguments(params)?
        {
            return Ok(Arguments::Memory(call));
        }
        if self.tag_sessions.offered()
            && params["namespace"] == "supertag"
            && let Some(call) = crate::tag_sessions::arguments(params)?
        {
            return Ok(Arguments::TagSessions(call));
        }
        coordination::arguments(params, self.coordination)
    }
}

pub(crate) struct Bridge {
    client: HarnessQuestionsClient<Channel>,
    artifacts: HarnessArtifactsClient<Channel>,
    token: String,
    task_id: String,
    tag_id: String,
    session_id: String,
    attempt_id: String,
    capabilities: AttemptCapabilities,
    tools: Tools,
    current: Tools,
    coordination: coordination::Client,
    tag_sessions: crate::tag_sessions::Client,
    schedules: crate::schedules::Client,
    memory: crate::memory::Client,
    calls: BTreeMap<String, (Arguments, Value)>,
    secrets: Vec<String>,
    asked: bool,
    report: Option<ObjectiveReport>,
    quiet: Option<String>,
}
impl Bridge {
    pub(crate) fn new(
        (channel, artifact_channel): (Channel, Channel),
        token: &str,
        task: &supertag_protocol::v2::Task,
        attempt_id: &str,
        capabilities: AttemptCapabilities,
        tools: Tools,
        current: Tools,
    ) -> Self {
        Self {
            client: HarnessQuestionsClient::new(channel.clone())
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .max_decoding_message_size(MAX_MESSAGE_BYTES),
            artifacts: HarnessArtifactsClient::new(artifact_channel)
                .max_encoding_message_size(MAX_MESSAGE_BYTES)
                .max_decoding_message_size(MAX_MESSAGE_BYTES),
            token: token.into(),
            task_id: task.task_id.clone(),
            tag_id: task.tag_id.clone(),
            session_id: task.session_id.clone(),
            attempt_id: attempt_id.into(),
            capabilities,
            tools,
            current,
            tag_sessions: crate::tag_sessions::Client::new(channel.clone()),
            schedules: crate::schedules::Client::new(channel.clone()),
            memory: crate::memory::Client::new(channel.clone()),
            coordination: coordination::Client::new(channel),
            calls: BTreeMap::new(),
            secrets: vec![],
            asked: false,
            report: None,
            quiet: None,
        }
    }
    pub(crate) fn enabled(&self) -> bool {
        self.tools.enabled()
    }

    pub(crate) fn inventory(&self) -> Tools {
        self.tools
    }
    /// The Tag portfolio for this turn's context, when this turn reads the Tag's Sessions.
    pub(crate) fn portfolio(&self) -> &str {
        if self.tools.tag_sessions == crate::tag_sessions::Reads::All
            && self.capabilities.may_read_tag_sessions
        {
            &self.capabilities.tag_portfolio
        } else {
            ""
        }
    }
    pub(crate) fn set_secrets(&mut self, secrets: &[String]) {
        self.secrets = secrets.to_vec();
    }
    pub(crate) fn waiting_approvals(&self) -> Vec<String> {
        let mut ids: Vec<_> = self.coordination.pending.values().cloned().collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    }
    /// The Objective status this turn reported, unless it asked a question or left
    /// approvals pending. A failed turn never applies it.
    pub(crate) fn objective_report(&self) -> Option<ObjectiveReport> {
        if self.asked || !self.coordination.pending.is_empty() {
            return None;
        }
        self.report.clone()
    }
    /// Why this turn stays quiet, if it called `stay_quiet` and reported nothing, asked
    /// nothing, and left no approvals pending.
    pub(crate) fn quiet_note(&self) -> Option<String> {
        if self.asked || self.report.is_some() || !self.coordination.pending.is_empty() {
            return None;
        }
        self.quiet.clone()
    }
    pub(crate) fn manifest(&self) -> String {
        self.tools.manifest()
    }
    pub(crate) fn tools(&self) -> Value {
        let mut specs = tool_specs(self.tools.coordination);
        if self.tools.capture_artifact {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .push(crate::artifact::spec());
        }
        if self.tools.acquire_artifacts {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .extend(crate::artifact::acquisition_specs(
                    self.tools.attach_artifacts,
                ));
        }
        if self.tools.tag_sessions.offered() {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .extend(crate::tag_sessions::tool_specs(self.tools.tag_sessions));
        }
        if self.tools.close_sessions {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .push(coordination::close_spec());
        }
        // The Tag's open Work Sessions, so the model knows its room before it starts one.
        if self.capabilities.may_start_work_session && self.capabilities.max_work_sessions > 0 {
            for tool in specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
            {
                if tool["name"] == "start_session" {
                    let description = tool["description"].as_str().unwrap_or_default().to_owned();
                    tool["description"] = json!(format!(
                        "{} This Tag has {} of {} Work Sessions open; close one that is done with close_session.",
                        description,
                        self.capabilities.open_work_sessions,
                        self.capabilities.max_work_sessions
                    ));
                }
            }
        }
        if self.tools.schedule {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .extend(crate::schedules::tool_specs(
                    &self.capabilities.time_zone,
                    std::time::SystemTime::now().into(),
                ));
        }
        if self.tools.memory {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .extend(crate::memory::tool_specs());
        }
        if self.tools.report_objective.offered() {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .push(report_spec(self.tools.report_objective));
        }
        if self.tools.quiet {
            specs[0]["tools"]
                .as_array_mut()
                .expect("tool specifications")
                .push(quiet_spec());
        }
        specs
    }
    pub(crate) async fn call(&mut self, params: &Value) -> Result<Value> {
        ensure!(
            self.enabled(),
            "Codex coordination tools were not admitted for this Task"
        );
        let arguments = match self.tools.arguments(params) {
            Ok(arguments) => arguments,
            Err(error) => match coordination::retryable(&error) {
                Some(mistake) => return Ok(coordination::response(mistake.to_string(), false)),
                None => return Err(error),
            },
        };
        let call_id = params["callId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
            .context("Codex tool call identity is invalid")?;
        if let Some((previous, result)) = self.calls.get(call_id) {
            ensure!(
                previous == &arguments,
                "Codex reused a tool call identity with different arguments"
            );
            return Ok(result.clone());
        }
        ensure!(
            self.calls.len() < 32,
            "Codex exceeded its coordination tool call limit"
        );
        let operation_id = format!(
            "codex-{:x}",
            Sha256::digest(serde_json::to_vec(&(
                params["threadId"].as_str(),
                params["turnId"].as_str(),
                params["tool"].as_str(),
                call_id
            ))?)
        );
        let result = match &arguments {
            Arguments::Acquire(acquisition)
                if self.current.acquire_artifacts
                    && (!acquisition.materializes() || self.current.attach_artifacts)
                    && !self.asked =>
            {
                acquisition
                    .invoke(
                        &mut self.artifacts,
                        operation_id,
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::Capture(capture) if self.current.capture_artifact && !self.asked => {
                capture
                    .invoke(
                        &mut self.artifacts,
                        operation_id,
                        (&self.task_id, &self.attempt_id),
                        params["threadId"].as_str(),
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::Ask(text)
                if self.tools.coordination == Inventory::ChildQuestions
                    && self.capabilities.may_ask_work_session_question
                    && self.coordination.pending.is_empty() =>
            {
                let reply = self
                    .coordination
                    .ask_work_session(
                        operation_id,
                        crate::auth::redact(text.clone(), &self.secrets),
                        (&self.task_id, &self.attempt_id, &self.session_id),
                        &self.token,
                    )
                    .await?;
                self.asked |= reply["success"] == true;
                reply
            }
            Arguments::Ask(text)
                if self.capabilities.may_ask_objective_question
                    && self.report.is_none()
                    && self.coordination.pending.is_empty() =>
            {
                let reply = self
                    .ask(
                        operation_id,
                        crate::auth::redact(text.clone(), &self.secrets),
                    )
                    .await?;
                self.asked |= reply["success"] == true;
                reply
            }
            Arguments::Post(post) if self.capabilities.may_use_workstream && !self.asked => {
                self.coordination
                    .post(
                        post,
                        operation_id,
                        &self.task_id,
                        &self.attempt_id,
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::ReadWorkstream(page) if self.capabilities.may_use_workstream => {
                self.coordination
                    .read_workstream(page, &self.token, &self.secrets)
                    .await?
            }
            Arguments::ReadMailbox(page) if self.capabilities.may_read_mailbox => {
                self.coordination
                    .read_mailbox(page, &self.tag_id, &self.token, &self.secrets)
                    .await?
            }
            Arguments::ReadReviewPatch(page) if self.capabilities.may_read_mailbox => {
                self.coordination
                    .read_review_patch(page, &self.token, &self.secrets)
                    .await?
            }
            Arguments::Send(message)
                if !self.asked
                    && (self.capabilities.may_send_tag_message
                        || (self.capabilities.may_request_commit_review
                            && message.requests_review())) =>
            {
                self.coordination
                    .send(
                        message,
                        operation_id,
                        (&self.task_id, &self.attempt_id, &self.tag_id),
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::Start(start)
                if self.capabilities.may_start_work_session
                    && !self.asked
                    && self.coordination.pending.is_empty() =>
            {
                self.coordination
                    .start_session(
                        start,
                        operation_id,
                        (&self.task_id, &self.tag_id, &self.session_id),
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::Continue(continuation)
                if self.capabilities.may_continue_work_session
                    && !self.asked
                    && self.coordination.pending.is_empty() =>
            {
                self.coordination
                    .continue_session(
                        continuation,
                        operation_id,
                        (&self.task_id, &self.tag_id, &self.session_id),
                        &self.token,
                        &self.secrets,
                    )
                    .await?
            }
            Arguments::TagSessions(call)
                if self.current.tag_sessions.allows(call)
                    && crate::tag_sessions::Reads::new(&self.capabilities).allows(call)
                    && !self.asked =>
            {
                self.tag_sessions
                    .call(call, &self.token, &self.secrets)
                    .await?
            }
            Arguments::CloseSession(id)
                if self.current.close_sessions
                    && self.capabilities.may_start_work_session
                    && !self.asked =>
            {
                self.coordination
                    .close_session(id, &self.tag_id, &self.token, &self.secrets)
                    .await?
            }
            Arguments::Schedule(call)
                if self.current.schedule && self.capabilities.may_schedule && !self.asked =>
            {
                self.schedules
                    .call(call, operation_id, &self.token, &self.secrets)
                    .await?
            }
            Arguments::Memory(call)
                if self.current.memory && self.capabilities.may_remember && !self.asked =>
            {
                self.memory
                    .call(call, operation_id, &self.token, &self.secrets)
                    .await?
            }
            // An ongoing Objective never completes. Refuse that status so the owner
            // can recover, rather than failing the turn at Finish.
            Arguments::Report(report)
                if self.current.report_objective.offered()
                    && (report.signal == ObjectiveSignal::Completed
                        && (self.capabilities.objective_ongoing
                            || self.tools.report_objective == Reporting::Ongoing)) =>
            {
                coordination::response(ONGOING_COMPLETION_REFUSED, false)
            }
            Arguments::Report(report)
                if self.current.report_objective.offered()
                    && !self.asked
                    && self.coordination.pending.is_empty() =>
            {
                self.report = Some(ObjectiveReport {
                    signal: report.signal,
                    summary: crate::auth::redact(report.summary.clone(), &self.secrets),
                });
                coordination::response(
                    "Objective status recorded. It applies when this turn ends, and your summary becomes this turn's result.",
                    true,
                )
            }
            Arguments::Quiet(note)
                if self.current.quiet
                    && self.capabilities.may_stay_quiet
                    && !self.asked
                    && self.report.is_none()
                    && self.coordination.pending.is_empty() =>
            {
                self.quiet = Some(crate::auth::redact(note.clone(), &self.secrets));
                coordination::response(QUIET_RECORDED, true)
            }
            _ => coordination::refused(),
        };
        self.calls
            .insert(call_id.into(), (arguments, result.clone()));
        Ok(result)
    }

    async fn ask(&mut self, operation_id: String, text: String) -> Result<Value> {
        let input = HarnessAskQuestionRequest {
            operation_id,
            text: text.clone(),
        };
        let mut result = None;
        for retry in 0..3 {
            match self
                .client
                .ask_question(crate::request(input.clone(), &self.token)?)
                .await
            {
                Ok(response) => {
                    let question = response.into_inner();
                    ensure!(
                        question.task_id == self.task_id
                            && question.attempt_id == self.attempt_id
                            && question.text == text
                            && !question.objective_id.is_empty(),
                        "Objective question receipt has mismatched identity"
                    );
                    result = Some(
                        json!({"success":true,"contentItems":[{"type":"inputText","text":"Your question was recorded. End this turn with a short reply and make no further tool calls. The operator's answer arrives in this Session's next Task."}]}),
                    );
                    break;
                }
                Err(status)
                    if retry < 2
                        && matches!(status.code(), Code::Unavailable | Code::DeadlineExceeded) =>
                {
                    tokio::time::sleep(Duration::from_millis(50)).await
                }
                Err(status)
                    if matches!(
                        status.code(),
                        Code::PermissionDenied
                            | Code::Unauthenticated
                            | Code::FailedPrecondition
                            | Code::AlreadyExists
                            | Code::InvalidArgument
                    ) =>
                {
                    result = Some(
                        json!({"success":false,"contentItems":[{"type":"inputText","text":"The Objective question was refused. End your turn and report that the question could not be accepted."}]}),
                    );
                    break;
                }
                Err(_) => bail!("could not confirm the Objective question receipt"),
            }
        }
        result.context("could not confirm the Objective question receipt")
    }
}

pub(crate) fn tool_specs(inventory: Inventory) -> Value {
    let (description, max) = if inventory == Inventory::ChildQuestions {
        (
            "Record one question for the parent Session. Finish this turn so the parent can receive it and relay an answer.",
            2000,
        )
    } else {
        (
            "Ask the operator one question needed to continue this Objective. After this returns, end your turn with a short reply and make no further tool calls. The answer arrives in this Session's next Task.",
            16000,
        )
    };
    let mut tools = Vec::new();
    if inventory != Inventory::None {
        tools.push(json!({
        "type":"function", "name":"ask",
        "description":description,
        "inputSchema":{
            "type":"object", "properties":{"text":{"type":"string","minLength":1,"maxLength":max}},
            "required":["text"], "additionalProperties":false
        }
        }));
    }
    if inventory >= Inventory::Workstream {
        tools.extend(coordination::tool_specs(inventory));
    }
    json!([{
        "type":"namespace", "name":"supertag",
        "description":"Coordination through this Task's supervised execution.",
        "tools":tools
    }])
}

pub(crate) fn validate_tool(params: &Value) -> Result<String> {
    ensure!(
        params["namespace"] == "supertag" && params["tool"] == "ask",
        "Codex requested an unregistered coordination tool"
    );
    let args = params["arguments"]
        .as_object()
        .context("Codex question arguments must be an object")?;
    ensure!(
        args.len() == 1,
        "Codex question arguments do not match the admitted schema"
    );
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .context("Codex question text is missing")?
        .trim();
    ensure!(
        !text.is_empty() && text.encode_utf16().count() <= 16_000 && !text.contains('\0'),
        "Codex question text is invalid"
    );
    Ok(text.into())
}

fn report_spec(reporting: Reporting) -> Value {
    let (description, statuses) = if reporting == Reporting::Ongoing {
        (
            "Report this ongoing Objective's status when the turn ends: ready_for_review when a person should review your assessment, or blocked when you cannot continue without help. An ongoing Objective never completes; only an operator ends it. The summary becomes this turn's result. Call this last, then finish the turn.",
            json!(["ready_for_review", "blocked"]),
        )
    } else {
        (
            "Report this Objective's status when the turn ends: ready_for_review when the outcome is met and a person should review it, completed when it is met and needs no review, or blocked when you cannot continue without help. The summary becomes this turn's result. Call this last, then finish the turn.",
            json!(["ready_for_review", "completed", "blocked"]),
        )
    };
    json!({
        "type":"function", "name":"report_objective",
        "description":description,
        "inputSchema":{
            "type":"object",
            "properties":{
                "status":{"type":"string","enum":statuses},
                "summary":{"type":"string","minLength":1,"maxLength":REPORT_SUMMARY_MAX}
            },
            "required":["status","summary"], "additionalProperties":false
        }
    })
}

/// What `stay_quiet` tells the model; the harness adapters say the same.
pub(crate) const QUIET_DESCRIPTION: &str = "Finish this turn without posting anything, when it found nothing that needs a person's attention: no reply is posted to the thread or conversation and nothing counts as unread. The note says why in one line; it is kept in the Tag's history, never posted. Use it only when nothing changed since what you last reported. Report a change even when it seems minor, and say when a problem you reported is resolved; the person decides what matters. A problem the person already knows about and someone is handling, with nothing new, needs no message. Call this last, then finish the turn.";
const QUIET_RECORDED: &str =
    "Recorded: nothing from this turn is posted.";

fn quiet_spec() -> Value {
    json!({
        "type":"function", "name":"stay_quiet",
        "description":QUIET_DESCRIPTION,
        "inputSchema":{
            "type":"object",
            "properties":{"note":{"type":"string","minLength":1,"maxLength":QUIET_NOTE_MAX}},
            "required":["note"], "additionalProperties":false
        }
    })
}

pub(crate) fn validate_quiet(params: &Value) -> Result<String> {
    ensure!(
        params["namespace"] == "supertag" && params["tool"] == "stay_quiet",
        "Codex requested an unregistered coordination tool"
    );
    let args = params["arguments"]
        .as_object()
        .context("Codex stay_quiet arguments must be an object")?;
    ensure!(
        args.len() == 1,
        "Codex stay_quiet arguments do not match the admitted schema"
    );
    let note = args
        .get("note")
        .and_then(Value::as_str)
        .context("Codex stay_quiet note is missing")?
        .trim();
    ensure!(
        !note.is_empty() && note.chars().count() <= QUIET_NOTE_MAX && !note.contains('\0'),
        "Codex stay_quiet note is invalid"
    );
    Ok(note.into())
}

pub(crate) fn validate_report(params: &Value) -> Result<ObjectiveReport> {
    ensure!(
        params["namespace"] == "supertag" && params["tool"] == "report_objective",
        "Codex requested an unregistered coordination tool"
    );
    let args = params["arguments"]
        .as_object()
        .context("Codex Objective report arguments must be an object")?;
    ensure!(
        args.len() == 2,
        "Codex Objective report arguments do not match the admitted schema"
    );
    let signal = match args.get("status").and_then(Value::as_str) {
        Some("ready_for_review") => ObjectiveSignal::ReadyForReview,
        Some("completed") => ObjectiveSignal::Completed,
        Some("blocked") => ObjectiveSignal::Blocked,
        _ => bail!("Codex Objective report status is invalid"),
    };
    let summary = args
        .get("summary")
        .and_then(Value::as_str)
        .context("Codex Objective report summary is missing")?
        .trim();
    ensure!(
        !summary.is_empty()
            && summary.encode_utf16().count() <= REPORT_SUMMARY_MAX
            && !summary.contains('\0'),
        "Codex Objective report summary is invalid"
    );
    Ok(ObjectiveReport {
        signal,
        summary: summary.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(arguments: Value) -> Value {
        json!({"namespace":"supertag","tool":"report_objective","arguments":arguments})
    }

    #[test]
    fn report_maps_each_status_to_its_signal_and_trims_the_summary() -> Result<()> {
        for (status, signal) in [
            ("ready_for_review", ObjectiveSignal::ReadyForReview),
            ("completed", ObjectiveSignal::Completed),
            ("blocked", ObjectiveSignal::Blocked),
        ] {
            let report = validate_report(&call(json!({"status":status,"summary":"  Shipped. "})))?;
            assert_eq!(report.signal, signal);
            assert_eq!(report.summary, "Shipped.");
        }
        Ok(())
    }

    #[test]
    fn report_rejects_other_statuses_blank_or_oversized_summaries_and_extra_fields() {
        for arguments in [
            json!({"status":"progress","summary":"Working"}),
            json!({"status":"working","summary":"Working"}),
            json!({"status":"completed","summary":"   "}),
            json!({"status":"completed","summary":"a\0b"}),
            json!({"status":"completed","summary":"x".repeat(REPORT_SUMMARY_MAX + 1)}),
            json!({"status":"completed"}),
            json!({"summary":"Done"}),
            json!({"status":"completed","summary":"Done","objective_id":"other"}),
            json!(["completed", "Done"]),
        ] {
            assert!(
                validate_report(&call(arguments.clone())).is_err(),
                "{arguments}"
            );
        }
        let mut foreign = call(json!({"status":"completed","summary":"Done"}));
        foreign["namespace"] = json!("operator");
        assert!(validate_report(&foreign).is_err());
    }

    #[test]
    fn report_is_offered_and_parsed_only_when_admitted() -> Result<()> {
        let tools = |report_objective: Reporting| Tools {
            coordination: Inventory::Ask,
            capture_artifact: false,
            acquire_artifacts: false,
            attach_artifacts: false,
            tag_sessions: crate::tag_sessions::Reads::None,
            schedule: false,
            close_sessions: false,
            memory: false,
            quiet: false,
            report_objective,
        };
        let params = call(json!({"status":"completed","summary":"Done"}));
        assert!(matches!(
            tools(Reporting::Finishing).arguments(&params)?,
            Arguments::Report(_)
        ));
        // An ongoing Objective's call still parses, so the bridge can refuse it and the
        // turn continues.
        assert!(matches!(
            tools(Reporting::Ongoing).arguments(&params)?,
            Arguments::Report(_)
        ));
        assert!(tools(Reporting::None).arguments(&params).is_err());
        let statuses = |reporting| {
            report_spec(reporting)["inputSchema"]["properties"]["status"]["enum"].clone()
        };
        assert_eq!(
            statuses(Reporting::Finishing),
            json!(["ready_for_review", "completed", "blocked"])
        );
        assert_eq!(
            statuses(Reporting::Ongoing),
            json!(["ready_for_review", "blocked"])
        );
        assert!(
            report_spec(Reporting::Ongoing)["description"]
                .as_str()
                .is_some_and(|text| text.contains("never completes"))
        );
        let capabilities = |ask, ongoing| AttemptCapabilities {
            may_ask_objective_question: ask,
            objective_ongoing: ongoing,
            ..Default::default()
        };
        assert_eq!(Reporting::new(&capabilities(false, true)), Reporting::None);
        assert_eq!(
            Reporting::new(&capabilities(true, false)),
            Reporting::Finishing
        );
        assert_eq!(
            Reporting::new(&capabilities(true, true)),
            Reporting::Ongoing
        );
        Ok(())
    }
}
