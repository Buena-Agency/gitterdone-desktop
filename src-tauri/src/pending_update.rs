use std::sync::Mutex;

/// A failed install keeps the advertised update available, but concurrent clicks
/// and background checks cannot start or replace an installation in progress.
pub struct PendingUpdate<T> {
    state: Mutex<(Option<T>, bool)>,
}

impl<T> Default for PendingUpdate<T> {
    fn default() -> Self {
        Self { state: Mutex::new((None, false)) }
    }
}

impl<T: Clone> PendingUpdate<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn offer(&self, update: T) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.1 { return false; }
        state.0 = Some(update);
        true
    }

    pub fn begin(&self) -> Result<T, &'static str> {
        let mut state = self.state.lock().unwrap();
        if state.1 { return Err("An update is already being installed."); }
        let update = state.0.clone().ok_or("No update is available. Check again later.")?;
        state.1 = true;
        Ok(update)
    }

    pub fn failed(&self) {
        self.state.lock().unwrap().1 = false;
    }
}

#[cfg(test)]
mod tests {
    use super::PendingUpdate;

    #[test]
    fn a_missing_update_does_not_start_a_restart() {
        let pending = PendingUpdate::<u8>::new();
        assert!(pending.begin().is_err());
        assert!(pending.offer(1));
        assert_eq!(pending.begin(), Ok(1));
    }

    #[test]
    fn failed_install_retains_update_for_explicit_retry() {
        let pending = PendingUpdate::new();
        assert!(pending.offer(1));
        assert_eq!(pending.begin(), Ok(1));
        assert!(pending.begin().is_err());
        assert!(!pending.offer(2));
        pending.failed();
        assert_eq!(pending.begin(), Ok(1));
    }

    #[test]
    fn concurrent_clicks_can_claim_only_once() {
        let pending = std::sync::Arc::new(PendingUpdate::new());
        pending.offer(1);
        let threads: Vec<_> = (0..8).map(|_| {
            let pending = pending.clone();
            std::thread::spawn(move || pending.begin().is_ok())
        }).collect();
        let successes = threads.into_iter().map(|thread| thread.join().unwrap())
            .filter(|success| *success).count();
        assert_eq!(successes, 1);
    }
}
