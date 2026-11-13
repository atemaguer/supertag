use super::*;
use tonic::Code;

fn gateway() -> Gateway {
    Gateway::new(
        supertag_protocol::negotiation::bind_current(
            tonic::transport::Endpoint::from_static("http://127.0.0.1:1").connect_lazy(),
        ),
        "private-gateway".into(),
        "public-operator".into(),
        "operator:alice".into(),
    )
    .unwrap()
}

#[tokio::test]
async fn host_views_and_drain_reject_host_private_and_missing_operator_credentials() {
    let gateway = gateway();
    for credential in [
        None,
        Some("Bearer private-gateway"),
        Some("Bearer host-token"),
    ] {
        let mut list = Request::new(ListHostsRequest::default());
        let mut get = Request::new(GetHostRequest {
            host_id: "host-a".into(),
        });
        let mut drain = Request::new(SetHostDrainingRequest {
            host_id: "host-a".into(),
            draining: true,
        });
        if let Some(credential) = credential {
            for metadata in [
                list.metadata_mut(),
                get.metadata_mut(),
                drain.metadata_mut(),
            ] {
                metadata.insert(AUTHORIZATION, credential.parse().unwrap());
                metadata.insert(PRINCIPAL, MetadataValue::from_static("operator:forged"));
            }
        }
        assert_eq!(
            gateway.list_hosts(list).await.unwrap_err().code(),
            Code::Unauthenticated
        );
        assert_eq!(
            gateway.get_host(get).await.unwrap_err().code(),
            Code::Unauthenticated
        );
        assert_eq!(
            gateway.set_host_draining(drain).await.unwrap_err().code(),
            Code::Unauthenticated
        );
    }
}

#[tokio::test]
async fn host_presence_rejects_operator_credential_before_reading_its_report() {
    let gateway = gateway();
    let mut request = Request::new(ReportHostRequest {
        sequence: u64::MAX,
        ..Default::default()
    });
    request.metadata_mut().insert(
        AUTHORIZATION,
        MetadataValue::from_static("Bearer public-operator"),
    );
    request
        .metadata_mut()
        .insert(PRINCIPAL, MetadataValue::from_static("host:forged"));
    request
        .metadata_mut()
        .insert(HOST_GENERATION_HEADER, MetadataValue::from_static("1"));
    assert_eq!(
        gateway.report_host(request).await.unwrap_err().code(),
        Code::Unauthenticated
    );
}
