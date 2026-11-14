//! Conservative decisions over already validated GitHub observations. These
//! decisions never perform I/O and cannot turn an ambiguous write into a resend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub repository_id: u64,
    pub repository: String,
    pub branch: String,
    pub base: String,
    pub commit: String,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PullRequest {
    pub number: u64,
    pub head_repository_id: u64,
    pub head_repository: String,
    pub base_repository_id: u64,
    pub base_repository: String,
    pub head: String,
    pub base: String,
    pub commit: String,
    pub open: bool,
    pub merged: bool,
    pub draft: bool,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Discovery {
    New,
    Open(PullRequest),
    Hold(&'static str),
}

impl Target {
    pub fn matches(&self, value: &PullRequest) -> bool {
        value.number > 0
            && value.head_repository_id == self.repository_id
            && value.base_repository_id == self.repository_id
            && value.head_repository.eq_ignore_ascii_case(&self.repository)
            && value.base_repository.eq_ignore_ascii_case(&self.repository)
            && value.head == self.branch
            && value.base == self.base
    }

    /// Initial publication may push only absent work or the one open matching PR.
    /// A full page is incomplete evidence, and a branch without its PR is held.
    pub fn discover(
        &self,
        complete: bool,
        requests: &[PullRequest],
        branch_head: Option<&str>,
    ) -> Discovery {
        if !complete {
            return Discovery::Hold("pull request history is incomplete");
        }
        if requests.is_empty() {
            return if branch_head.is_none() {
                Discovery::New
            } else {
                Discovery::Hold("branch exists without one known pull request")
            };
        }
        if requests.len() != 1 {
            return Discovery::Hold("branch has multiple pull requests");
        }
        let request = &requests[0];
        if !self.matches(request) {
            return Discovery::Hold("pull request destination differs from accepted work");
        }
        if request.merged || !request.open {
            return Discovery::Hold("pull request is merged or closed");
        }
        Discovery::Open(request.clone())
    }

    /// After an ambiguous create, only read-only proof of the exact published
    /// commit can finish delivery. Absence is uncertainty, never permission to POST.
    pub fn reconcile_create(
        &self,
        complete: bool,
        requests: &[PullRequest],
    ) -> Option<PullRequest> {
        if !complete || requests.len() != 1 {
            return None;
        }
        let request = &requests[0];
        (self.matches(request)
            && request.open
            && !request.merged
            && request.commit == self.commit
            && request.title == self.title
            && request.body == self.body)
            .then(|| request.clone())
    }

    /// A preexisting PR must still have the same identity after a push before its
    /// title or body may be updated. Its head SHA can lag behind the Git ref.
    pub fn may_update_after_push(&self, expected_number: u64, current: &PullRequest) -> bool {
        current.number == expected_number
            && self.matches(current)
            && current.open
            && !current.merged
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> Target {
        Target {
            repository_id: 123,
            repository: "acme/project".into(),
            branch: "supertag/session/fixture".into(),
            base: "main".into(),
            commit: "1".repeat(40),
            title: "Change".into(),
            body: "Details".into(),
        }
    }
    fn pull() -> PullRequest {
        let target = target();
        PullRequest {
            number: 7,
            head_repository_id: 123,
            base_repository_id: 123,
            head_repository: target.repository.clone(),
            base_repository: target.repository,
            head: target.branch,
            base: target.base,
            commit: target.commit,
            open: true,
            merged: false,
            draft: true,
            title: target.title,
            body: target.body,
        }
    }
    #[test]
    fn only_new_or_one_open_exact_destination_may_publish() {
        let target = target();
        let request = pull();
        assert_eq!(target.discover(true, &[], None), Discovery::New);
        assert!(matches!(
            target.discover(true, &[], Some(&target.commit)),
            Discovery::Hold(_)
        ));
        assert!(matches!(
            target.discover(false, &[], None),
            Discovery::Hold(_)
        ));
        assert!(matches!(
            target.discover(true, &[request.clone(), request.clone()], None),
            Discovery::Hold(_)
        ));
        assert_eq!(
            target.discover(true, std::slice::from_ref(&request), Some(&request.commit)),
            Discovery::Open(request.clone())
        );
        for field in [
            "closed",
            "merged",
            "head repository",
            "base repository",
            "head",
            "base",
        ] {
            let mut changed = request.clone();
            match field {
                "closed" => changed.open = false,
                "merged" => changed.merged = true,
                "head repository" => changed.head_repository_id = 124,
                "base repository" => changed.base_repository = "acme/other".into(),
                "head" => changed.head = "another-branch".into(),
                _ => changed.base = "release".into(),
            }
            assert!(
                matches!(target.discover(true, &[changed], None), Discovery::Hold(_)),
                "{field}"
            );
        }
    }
    #[test]
    fn ambiguous_create_never_means_retry_and_requires_exact_head_proof() {
        let target = target();
        let request = pull();
        assert_eq!(target.reconcile_create(true, &[]), None);
        assert_eq!(
            target.reconcile_create(false, std::slice::from_ref(&request)),
            None
        );
        assert_eq!(
            target.reconcile_create(true, &[request.clone(), request.clone()]),
            None
        );
        assert_eq!(
            target.reconcile_create(true, std::slice::from_ref(&request)),
            Some(request.clone())
        );
        let mut changed = request.clone();
        changed.body = "old metadata".into();
        assert_eq!(target.reconcile_create(true, &[changed]), None);
        let mut changed = request;
        changed.commit = "2".repeat(40);
        assert_eq!(target.reconcile_create(true, &[changed]), None);
    }
    #[test]
    fn post_push_changes_do_not_authorize_updates_or_reopens() {
        let target = target();
        let mut request = pull();
        request.commit = "2".repeat(40);
        assert!(target.may_update_after_push(7, &request));
        assert!(!target.may_update_after_push(8, &request));
        request.open = false;
        assert!(!target.may_update_after_push(7, &request));
        request.open = true;
        request.merged = true;
        assert!(!target.may_update_after_push(7, &request));
    }
}
