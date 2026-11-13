use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tonic::transport::Endpoint;

use super::{ControlPlaneState, Result, Session, Tag, bearer, endpoint};

const STORE_ERROR: &str = "Could not read or save your Control Plane connections.";
const MAX_STORE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ORIGIN_BYTES: usize = 2048;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlPlaneProfile {
    name: String,
    origin: String,
}

#[derive(Deserialize, Serialize)]
struct SavedControlPlane {
    profile: ControlPlaneProfile,
    token: String,
}

#[derive(Default, Deserialize, Serialize)]
struct Profiles {
    active: Option<String>,
    control_planes: Vec<SavedControlPlane>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneList {
    profiles: Vec<ControlPlaneProfile>,
    active: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneActivation {
    control_planes: ControlPlaneList,
    connection_id: String,
    tags: Vec<Tag>,
}

#[cfg(test)]
impl ControlPlaneActivation {
    pub(super) fn connection_id(&self) -> &str {
        &self.connection_id
    }
}

impl From<Profiles> for ControlPlaneList {
    fn from(value: Profiles) -> Self {
        Self {
            active: value.active,
            profiles: value
                .control_planes
                .into_iter()
                .map(|entry| entry.profile)
                .collect(),
        }
    }
}

fn open_profiles(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    validate_profile_file(&file)?;
    Ok(file)
}

fn validate_profile_file(file: &File) -> io::Result<()> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::ErrorKind::InvalidData.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid takes no arguments.
        if metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
    }
    Ok(())
}

fn lock_profiles(path: &Path) -> Result<File> {
    let parent = path.parent().ok_or(STORE_ERROR)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
        builder.mode(0o700);
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        builder.create(parent).map_err(|_| STORE_ERROR)?;
        let metadata = fs::symlink_metadata(parent).map_err(|_| STORE_ERROR)?;
        // SAFETY: geteuid takes no arguments.
        if !metadata.is_dir()
            || metadata.mode() & 0o022 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err(STORE_ERROR.into());
        }
    }
    #[cfg(not(unix))]
    builder.create(parent).map_err(|_| STORE_ERROR)?;
    let lock_path = path.with_extension("lock");
    let file = options.open(&lock_path).map_err(|_| STORE_ERROR)?;
    validate_profile_file(&file).map_err(|_| STORE_ERROR)?;
    file.try_lock()
        .map_err(|_| "Another SuperTag window is updating the saved Control Planes. Try again.")?;
    Ok(file)
}

impl Profiles {
    fn load(path: &Path) -> Result<Self> {
        let file = match open_profiles(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(_) => return Err(STORE_ERROR.into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_STORE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| STORE_ERROR)?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(STORE_ERROR.into());
        }
        serde_json::from_slice(&bytes).map_err(|_| STORE_ERROR.into())
    }

    fn save(&self, path: &Path) -> Result<()> {
        let parent = path.parent().ok_or(STORE_ERROR)?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|_| STORE_ERROR)?;
        let bytes = serde_json::to_vec(self).map_err(|_| STORE_ERROR)?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err("The saved Control Plane list is too large.".into());
        }
        staged.write_all(&bytes).map_err(|_| STORE_ERROR)?;
        staged.as_file().sync_all().map_err(|_| STORE_ERROR)?;
        staged.persist(path).map_err(|_| STORE_ERROR)?;
        Ok(())
    }
}

fn control_plane_origin(address: &str) -> Result<(String, Endpoint)> {
    if address.len() > MAX_ORIGIN_BYTES {
        return Err("Enter a Control Plane URL of up to 2048 characters.".into());
    }
    let checked = endpoint(address)?;
    let url =
        tauri::Url::parse(&checked.uri().to_string()).map_err(|_| "Enter a valid Control Plane URL.")?;
    let origin = url.origin().ascii_serialization();
    let endpoint = endpoint(&origin)?;
    Ok((origin, endpoint))
}

impl ControlPlaneState {
    pub async fn saved_control_planes(&self, path: &Path) -> Result<ControlPlaneList> {
        let _guard = self.1.lock().await;
        Ok(Profiles::load(path)?.into())
    }

    pub async fn save_control_plane(
        &self,
        path: &Path,
        address: String,
        name: String,
        token: String,
    ) -> Result<ControlPlaneActivation> {
        let _guard = self.1.lock().await;
        let (origin, endpoint) = control_plane_origin(&address)?;
        let _file_lock = lock_profiles(path)?;
        let name = name.trim();
        if name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("Enter a Control Plane name of up to 80 characters.".into());
        }
        let mut profiles = Profiles::load(path)?;
        let stored = profiles
            .control_planes
            .iter_mut()
            .find(|entry| entry.profile.origin == origin);
        let name = if name.is_empty() {
            origin.clone()
        } else {
            name.into()
        };
        if let Some(entry) = stored {
            entry.profile.name = name;
            if !token.is_empty() {
                bearer(&token)?;
                entry.token = token;
            }
            let authorization = entry.token.clone();
            self.activate(path, profiles, origin, endpoint, &authorization)
                .await
        } else {
            bearer(&token)?;
            profiles.control_planes.push(SavedControlPlane {
                profile: ControlPlaneProfile {
                    name,
                    origin: origin.clone(),
                },
                token: token.clone(),
            });
            self.activate(path, profiles, origin, endpoint, &token)
                .await
        }
    }

    pub async fn select_control_plane(&self, path: &Path, origin: String) -> Result<ControlPlaneActivation> {
        let _guard = self.1.lock().await;
        let _file_lock = lock_profiles(path)?;
        let profiles = Profiles::load(path)?;
        let entry = profiles
            .control_planes
            .iter()
            .find(|entry| entry.profile.origin == origin)
            .ok_or("That Control Plane is no longer saved.")?;
        let token = entry.token.clone();
        let (canonical, endpoint) = control_plane_origin(&origin)?;
        if canonical != origin {
            return Err("The saved Control Plane address is invalid.".into());
        }
        self.activate(path, profiles, origin, endpoint, &token)
            .await
    }

    async fn activate(
        &self,
        path: &Path,
        mut profiles: Profiles,
        origin: String,
        endpoint: Endpoint,
        token: &str,
    ) -> Result<ControlPlaneActivation> {
        let generation = self.0.read().await.generation;
        let session = Arc::new(Session::connect(endpoint, token).await?);
        let tags = session.tags().await?;
        let mut state = self.0.write().await;
        if state.generation != generation {
            return Err("The connection changed. Connect again.".into());
        }
        profiles.active = Some(origin.clone());
        profiles.save(path)?;
        let connection_id = state.replace().to_string();
        state.session = Some(session);
        state.origin = Some(origin);
        Ok(ControlPlaneActivation {
            control_planes: profiles.into(),
            connection_id,
            tags,
        })
    }

    pub async fn clear_control_plane(&self, path: &Path, forget: Option<String>) -> Result<ControlPlaneList> {
        let _guard = self.1.lock().await;
        let _file_lock = lock_profiles(path)?;
        let mut profiles = Profiles::load(path)?;
        let mut state = self.0.write().await;
        if let Some(origin) = &forget {
            profiles
                .control_planes
                .retain(|entry| entry.profile.origin != *origin);
        }
        if forget
            .as_ref()
            .is_none_or(|origin| profiles.active.as_ref() == Some(origin))
        {
            profiles.active = None;
        }
        profiles.save(path)?;
        if forget
            .as_ref()
            .is_none_or(|origin| state.origin.as_ref() == Some(origin))
        {
            state.replace();
        }
        Ok(profiles.into())
    }
}
