//! Read-only moving-ref resolution. The Control Plane chooses the first durable pin.
use super::*;
use supertag_protocol::negotiation::ProtocolChannel;
use supertag_protocol::{MAX_MESSAGE_BYTES, authenticated_request, v2::*};
use tonic::Request;

impl GithubWorkspaceSources {
    pub(super) async fn resolve_selector(
        &self,
        selected: &GithubWorkspace,
    ) -> Result<(String, String)> {
        let source = selected
            .source
            .as_ref()
            .context("source selector is missing")?;
        ensure!(
            source.account_id == self.0.account
                && source.repository_id == self.0.repository_id
                && source.repository == self.0.repository
                && source.commit_sha.is_empty()
                && source.resolved_revision.is_none(),
            "source selector is not configured on this Gateway"
        );
        let token = self
            .0
            .authentication
            .access_token(&self.0.http, &self.0.api)
            .await?;
        let repository = self
            .json(
                &format!("repositories/{}", source.repository_id),
                token.expose(),
            )
            .await?;
        ensure!(
            repository.get("id").and_then(Value::as_u64) == Some(source.repository_id)
                && repository
                    .get("full_name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| name.eq_ignore_ascii_case(&source.repository)),
            "GitHub returned another repository"
        );
        let revision = source
            .revision
            .as_deref()
            .or_else(|| repository.get("default_branch").and_then(Value::as_str))
            .context("GitHub default branch is unavailable")?;
        ensure!(
            !revision.is_empty()
                && revision.len() <= 1024
                && revision.trim() == revision
                && !matches!(revision, "." | "..")
                && !revision.chars().any(char::is_control),
            "invalid GitHub source revision"
        );
        let mut endpoint = self
            .0
            .api
            .join(&format!("repos/{}/commits/", source.repository))?;
        endpoint
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid source endpoint"))?
            .pop_if_empty()
            .push(revision);
        let commit = self.json_url(endpoint, token.expose()).await?;
        let sha = commit
            .get("sha")
            .and_then(Value::as_str)
            .context("GitHub source commit is missing")?;
        ensure!(
            supertag_protocol::valid_git_commit(sha),
            "GitHub returned an invalid source commit"
        );
        Ok((revision.to_owned(), sha.to_owned()))
    }
    pub async fn run_resolver(
        &self,
        channel: ProtocolChannel,
        token: String,
        shutdown: CancellationToken,
    ) -> Result<()> {
        let principal = format!("source:github/{}", self.0.account);
        let request = |value| -> Result<Request<ListPendingGithubSourcesRequest>> {
            let mut request = authenticated_request(value, &token, Some(&principal))?;
            request.set_timeout(Duration::from_secs(5));
            Ok(request)
        };
        let mut client = github_source_resolver_client::GithubSourceResolverClient::new(channel)
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);
        let mut interval = time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
        let mut after_order = 0;
        loop {
            tokio::select! {_=shutdown.cancelled()=>return Ok(()),_=interval.tick()=>{}}
            let page = tokio::select! {_=shutdown.cancelled()=>return Ok(()),result=client.list_pending(request(ListPendingGithubSourcesRequest{after_order,limit:50})?)=>match result{Ok(page)=>page.into_inner(),Err(_)=>continue}};
            after_order = page.next_after_order;
            for pin in page.pins {
                let Some(selector) = pin.selector else {
                    continue;
                };
                let resolved = tokio::select! {_=shutdown.cancelled()=>return Ok(()),result=self.resolve_selector(&selector)=>result};
                let Ok((resolved_revision, commit_sha)) = resolved else {
                    continue;
                };
                let mut request = authenticated_request(
                    PinGithubSourceRequest {
                        pin_id: pin.pin_id,
                        selector_digest: pin.selector_digest,
                        resolved_revision,
                        commit_sha,
                    },
                    &token,
                    Some(&principal),
                )?;
                request.set_timeout(Duration::from_secs(5));
                tokio::select! {_=shutdown.cancelled()=>return Ok(()),_=client.pin(request)=>{}}
            }
        }
    }
}
