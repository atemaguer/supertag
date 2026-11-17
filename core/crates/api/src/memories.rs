use supertag_protocol::{MAX_MESSAGE_BYTES, v2::*};
use tonic::{Request, Response, Status};

use crate::Api;

impl Api {
    pub fn memories_service(&self) -> memories_server::MemoriesServer<Self> {
        memories_server::MemoriesServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }

    pub fn attempt_memory_service(&self) -> attempt_memory_server::AttemptMemoryServer<Self> {
        attempt_memory_server::AttemptMemoryServer::new(self.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES)
    }
}

/// Forwards an operator or client call to the state owner's Memories service.
macro_rules! memories {
    ($self:ident, $request:ident, $method:ident) => {
        $self
            .forward($request, |channel, request| async {
                memories_client::MemoriesClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .$method(request)
                    .await
            })
            .await
    };
}

/// Forwards a Worker Host call to the state owner's AttemptMemory service.
macro_rules! attempt_memory {
    ($self:ident, $request:ident, $method:ident) => {
        $self
            .forward_host($request, true, |channel, request| async {
                attempt_memory_client::AttemptMemoryClient::new(channel)
                    .max_decoding_message_size(MAX_MESSAGE_BYTES)
                    .max_encoding_message_size(MAX_MESSAGE_BYTES)
                    .$method(request)
                    .await
            })
            .await
    };
}

#[tonic::async_trait]
impl memories_server::Memories for Api {
    async fn list(
        &self,
        request: Request<ListMemoriesRequest>,
    ) -> Result<Response<ListMemoriesResponse>, Status> {
        memories!(self, request, list)
    }

    async fn get(&self, request: Request<GetMemoryRequest>) -> Result<Response<Memory>, Status> {
        memories!(self, request, get)
    }

    async fn delete(&self, request: Request<GetMemoryRequest>) -> Result<Response<Memory>, Status> {
        memories!(self, request, delete)
    }
}

#[tonic::async_trait]
impl attempt_memory_server::AttemptMemory for Api {
    async fn remember(
        &self,
        request: Request<AttemptRememberRequest>,
    ) -> Result<Response<AttemptMemoryResponse>, Status> {
        attempt_memory!(self, request, remember)
    }

    async fn forget(
        &self,
        request: Request<AttemptForgetRequest>,
    ) -> Result<Response<AttemptMemoryResponse>, Status> {
        attempt_memory!(self, request, forget)
    }
}
