use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status, transport::Channel};

use crate::Gateway;

impl Gateway {
    pub fn teams_service(&self) -> teams_server::TeamsServer<Self> {
        teams_server::TeamsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_workstreams_service(
        &self,
    ) -> attempt_workstreams_server::AttemptWorkstreamsServer<Self> {
        attempt_workstreams_server::AttemptWorkstreamsServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

#[tonic::async_trait]
impl teams_server::Teams for Gateway {
    async fn create_team(
        &self,
        request: Request<CreateTeamRequest>,
    ) -> Result<Response<Team>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { teams(channel).create_team(request).await },
        )
        .await
    }

    async fn get_team(&self, request: Request<GetTeamRequest>) -> Result<Response<Team>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { teams(channel).get_team(request).await },
        )
        .await
    }

    async fn list_teams(
        &self,
        request: Request<ListTeamsRequest>,
    ) -> Result<Response<ListTeamsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { teams(channel).list_teams(request).await },
        )
        .await
    }

    async fn update_team(
        &self,
        request: Request<UpdateTeamRequest>,
    ) -> Result<Response<Team>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { teams(channel).update_team(request).await },
        )
        .await
    }

    async fn delete_team(
        &self,
        request: Request<DeleteTeamRequest>,
    ) -> Result<Response<Team>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { teams(channel).delete_team(request).await },
        )
        .await
    }

    async fn list_workstream_posts(
        &self,
        request: Request<ListWorkstreamPostsRequest>,
    ) -> Result<Response<ListWorkstreamPostsResponse>, Status> {
        self.forward(
            request,
            &self.credentials.operator,
            |channel, request| async { teams(channel).list_workstream_posts(request).await },
        )
        .await
    }
}

#[tonic::async_trait]
impl attempt_workstreams_server::AttemptWorkstreams for Gateway {
    async fn read_attempt_workstream(
        &self,
        request: Request<ReadAttemptWorkstreamRequest>,
    ) -> Result<Response<ReadAttemptWorkstreamResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempts(channel).read_attempt_workstream(request).await
        })
        .await
    }

    async fn post_attempt_workstream(
        &self,
        request: Request<PostAttemptWorkstreamRequest>,
    ) -> Result<Response<PostAttemptWorkstreamResponse>, Status> {
        self.forward_host(request, true, |channel, request| async {
            attempts(channel).post_attempt_workstream(request).await
        })
        .await
    }
}

fn teams(channel: Channel) -> teams_client::TeamsClient<Channel> {
    teams_client::TeamsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}

fn attempts(channel: Channel) -> attempt_workstreams_client::AttemptWorkstreamsClient<Channel> {
    attempt_workstreams_client::AttemptWorkstreamsClient::new(channel)
        .max_decoding_message_size(MAX_MESSAGE_BYTES)
        .max_encoding_message_size(MAX_MESSAGE_BYTES)
}
