import React, { useState, useEffect } from 'react';
import {
  Peserta,
  Penguji,
  Kelompok,
  PenilaianPeserta,
  AppSettings,
  AuthUser,
} from '../types';
import {
  signInWithGoogle,
  signOutGoogle,
  getGoogleAccessToken,
  getCurrentGoogleUser,
  initGoogleAuth,
} from '../utils/googleAuth';
import {
  GOOGLE_DRIVE_FOLDER_ID,
  GOOGLE_DRIVE_FOLDER_URL,
  MASTER_SYNC_FILENAME,
  verifyFolderAccess,
  findMasterSyncFile,
  downloadJsonFile,
  uploadJsonToDrive,
  updateJsonInDrive,
  listFolderFiles,
  mergeAndUpdateAppData,
  buildAdminDeletionSyncPayload,
  SyncPayload,
  SyncMergeReport,
  DriveFileInfo,
} from '../utils/googleDrive';
import {
  X,
  Cloud,
  RefreshCw,
  UploadCloud,
  DownloadCloud,
  FolderCheck,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  ShieldAlert,
  Clock,
  Database,
  FileJson,
  Layers,
  ArrowRight,
  Sparkles,
  Info,
} from 'lucide-react';
import { formatTanggalIndonesia } from '../utils/formatDate';

interface DriveSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: AuthUser | null;
  pesertaList: Peserta[];
  pengujiList: Penguji[];
  kelompokList: Kelompok[];
  penilaianMap: Record<string, PenilaianPeserta>;
  settings: AppSettings;
  onApplySyncData: (
    newPeserta: Peserta[],
    newPenguji: Penguji[],
    newKelompok: Kelompok[],
    newPenilaian: Record<string, PenilaianPeserta>,
    newSettings?: AppSettings
  ) => void;
}

export const DriveSyncModal: React.FC<DriveSyncModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  pesertaList,
  pengujiList,
  kelompokList,
  penilaianMap,
  settings,
  onApplySyncData,
}) => {
  // Auth state
  const [googleUser, setGoogleUser] = useState(getCurrentGoogleUser());
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [folderCheck, setFolderCheck] = useState<{
    checked: boolean;
    accessible: boolean;
    name?: string;
    error?: string;
  }>({ checked: false, accessible: false });

  // Sync / Operation states
  const [activeTab, setActiveTab] = useState<'sync' | 'backups' | 'info'>('sync');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = useState<string>('');
  const [lastReport, setLastReport] = useState<SyncMergeReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Backup files list in folder
  const [backupFiles, setBackupFiles] = useState<DriveFileInfo[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);

  // Confirmation dialog state for destructive/admin operations
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    warningText?: string;
    confirmButtonText: string;
    onConfirm: () => Promise<void>;
  } | null>(null);

  const isAdmin = currentUser?.role === 'admin';

  // Watch Google auth changes
  useEffect(() => {
    const unsubscribe = initGoogleAuth((user, token) => {
      setGoogleUser(user);
      if (token && user) {
        checkFolder(token);
      } else {
        setFolderCheck({ checked: false, accessible: false });
      }
    });
    return () => unsubscribe();
  }, []);

  // When modal opens and already logged in, check folder and backups
  useEffect(() => {
    if (isOpen) {
      getGoogleAccessToken().then((token) => {
        if (token) {
          checkFolder(token);
          loadBackups(token);
        }
      });
    }
  }, [isOpen]);

  const checkFolder = async (token: string) => {
    const res = await verifyFolderAccess(token);
    setFolderCheck({
      checked: true,
      accessible: res.accessible,
      name: res.name,
      error: res.error,
    });
  };

  const loadBackups = async (token?: string) => {
    try {
      setLoadingBackups(true);
      const accToken = token || (await getGoogleAccessToken());
      if (!accToken) return;
      const files = await listFolderFiles(accToken);
      setBackupFiles(files);
    } catch (e: any) {
      console.error('Error loading backup list:', e);
    } finally {
      setLoadingBackups(false);
    }
  };

  // Google Login Handler
  const handleGoogleSignIn = async () => {
    try {
      setIsAuthenticating(true);
      setErrorMessage(null);
      const res = await signInWithGoogle();
      if (res) {
        setGoogleUser(res.user);
        await checkFolder(res.accessToken);
        await loadBackups(res.accessToken);
      }
    } catch (err: any) {
      setErrorMessage(
        err.message || 'Gagal masuk dengan akun Google. Silakan coba kembali.'
      );
    } finally {
      setIsAuthenticating(false);
    }
  };

  // Google Sign Out Handler
  const handleGoogleSignOut = async () => {
    try {
      await signOutGoogle();
      setGoogleUser(null);
      setFolderCheck({ checked: false, accessible: false });
      setBackupFiles([]);
      setSyncStatus('idle');
      setLastReport(null);
    } catch (err: any) {
      console.error('Sign out error:', err);
    }
  };

  // ==========================================================
  // 1. SINKRONISASI CERDAS (MERGE & UPDATE) - SEMUA PENGGUNA
  // ==========================================================
  const handleMergeAndUpdateSync = async () => {
    if (!currentUser) return;
    setErrorMessage(null);
    setSyncStatus('syncing');
    setSyncMessage('Memeriksa koneksi & token Google Drive...');

    try {
      let accessToken = await getGoogleAccessToken();
      if (!accessToken) {
        setSyncMessage('Menghubungkan akun Google...');
        const authRes = await signInWithGoogle();
        if (!authRes) throw new Error('Autentikasi Google dibatalkan.');
        accessToken = authRes.accessToken;
      }

      setSyncMessage('Mengunduh data master dari Google Drive...');
      const masterFile = await findMasterSyncFile(accessToken);
      let remotePayload: SyncPayload | null = null;

      if (masterFile) {
        try {
          remotePayload = await downloadJsonFile<SyncPayload>(accessToken, masterFile.id);
        } catch (e: any) {
          console.warn('Gagal membaca remote master payload, inisialisasi baru', e);
        }
      }

      setSyncMessage('Menggabungkan data lokal & cloud dengan teknik Merge and Update...');
      const { merged, report } = mergeAndUpdateAppData(
        {
          peserta: pesertaList,
          penguji: pengujiList,
          kelompok: kelompokList,
          penilaian: penilaianMap,
          settings,
        },
        remotePayload,
        currentUser,
        googleUser?.email || undefined
      );

      setSyncMessage('Menyimpan data hasil penggabungan ke Google Drive...');
      if (masterFile) {
        await updateJsonInDrive(
          accessToken,
          masterFile.id,
          merged,
          `Master Sync diperbarui oleh ${currentUser.displayName} (${currentUser.role})`
        );
      } else {
        await uploadJsonToDrive(
          accessToken,
          MASTER_SYNC_FILENAME,
          merged,
          'Master Data Sinkronisasi Pramuka Garuda Banyumas'
        );
      }

      // Terapkan ke state aplikasi lokal
      onApplySyncData(
        merged.peserta,
        merged.penguji,
        merged.kelompok,
        merged.penilaian,
        merged.settings
      );

      setLastReport(report);
      setSyncStatus('success');
      setSyncMessage('Sinkronisasi Merge & Update berhasil!');
      loadBackups(accessToken);
    } catch (err: any) {
      console.error('Merge sync error:', err);
      setSyncStatus('error');
      setErrorMessage(err.message || 'Terjadi kesalahan saat sinkronisasi data.');
    }
  };

  // ==========================================================
  // 2. SINKRONISASI PENGHAPUSAN (KHUSUS ADMIN)
  // ==========================================================
  const triggerAdminDeletionSync = () => {
    if (!isAdmin) return;

    setConfirmDialog({
      isOpen: true,
      title: 'Konfirmasi Sinkronisasi Penghapusan (Admin)',
      message:
        'Anda akan memperbarui master data di Google Drive agar persis sesuai data lokal saat ini. Setiap peserta, penguji, tim, atau nilai yang telah Anda hapus di lokal akan ikut disesuaikan (dihapus) di Google Drive.',
      warningText:
        'PERHATIAN: Tindakan ini memutasi file cloud. Sistem akan membuat salinan cadangan darurat (snapshot) di Google Drive sebelum proses dimulai.',
      confirmButtonText: 'Ya, Lanjutkan Sinkronisasi Penghapusan',
      onConfirm: async () => {
        setConfirmDialog(null);
        await executeAdminDeletionSync();
      },
    });
  };

  const executeAdminDeletionSync = async () => {
    if (!currentUser || !isAdmin) return;
    setErrorMessage(null);
    setSyncStatus('syncing');
    setSyncMessage('Menyiapkan otorisasi Admin Google Drive...');

    try {
      let accessToken = await getGoogleAccessToken();
      if (!accessToken) {
        const authRes = await signInWithGoogle();
        if (!authRes) throw new Error('Autentikasi Google dibatalkan.');
        accessToken = authRes.accessToken;
      }

      setSyncMessage('Memeriksa master data cloud dan membuat salinan cadangan pengaman...');
      const masterFile = await findMasterSyncFile(accessToken);
      let remotePayload: SyncPayload | null = null;

      if (masterFile) {
        try {
          remotePayload = await downloadJsonFile<SyncPayload>(accessToken, masterFile.id);
          // Buat snapshot pengaman
          const snapshotName = `backup_pengaman_sebelum_sync_admin_${Date.now()}.json`;
          await uploadJsonToDrive(
            accessToken,
            snapshotName,
            remotePayload,
            `Snapshot pengaman otomatis sebelum sinkronisasi penghapusan oleh ${currentUser.displayName}`
          );
        } catch (e) {
          console.warn('Gagal membaca remote payload untuk snapshot', e);
        }
      }

      setSyncMessage('Menyesuaikan data master cloud dengan data lokal Admin...');
      const { payload, report } = buildAdminDeletionSyncPayload(
        {
          peserta: pesertaList,
          penguji: pengujiList,
          kelompok: kelompokList,
          penilaian: penilaianMap,
          settings,
        },
        remotePayload,
        currentUser,
        googleUser?.email || undefined
      );

      if (masterFile) {
        await updateJsonInDrive(
          accessToken,
          masterFile.id,
          payload,
          `Master Sync diselaraskan dengan data Admin oleh ${currentUser.displayName}`
        );
      } else {
        await uploadJsonToDrive(
          accessToken,
          MASTER_SYNC_FILENAME,
          payload,
          'Master Data Sinkronisasi Pramuka Garuda Banyumas (Admin Overwrite)'
        );
      }

      // Terapkan ke state lokal
      onApplySyncData(
        payload.peserta,
        payload.penguji,
        payload.kelompok,
        payload.penilaian,
        payload.settings
      );

      setLastReport(report);
      setSyncStatus('success');
      setSyncMessage(
        'Sinkronisasi Penghapusan Berhasil! Data Google Drive telah disesuaikan dengan data lokal Admin.'
      );
      loadBackups(accessToken);
    } catch (err: any) {
      console.error('Admin deletion sync error:', err);
      setSyncStatus('error');
      setErrorMessage(err.message || 'Gagal menyinkronkan data penghapusan.');
    }
  };

  // ==========================================================
  // 3. BUAT FILE CADANGAN BARU (MANUAL BACKUP)
  // ==========================================================
  const handleCreateManualBackup = async () => {
    if (!currentUser) return;
    setErrorMessage(null);
    setSyncStatus('syncing');
    setSyncMessage('Membuat file cadangan lengkap...');

    try {
      let accessToken = await getGoogleAccessToken();
      if (!accessToken) {
        const authRes = await signInWithGoogle();
        if (!authRes) throw new Error('Autentikasi Google dibatalkan.');
        accessToken = authRes.accessToken;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `cadangan_pramuka_garuda_${timestamp}.json`;

      const backupPayload: SyncPayload = {
        version: 1,
        appName: 'Penilaian Pramuka Garuda Kemranjen-Siaga',
        lastSyncedAt: new Date().toISOString(),
        syncedBy: {
          role: currentUser.role,
          username: currentUser.username,
          displayName: currentUser.displayName,
          googleEmail: googleUser?.email || undefined,
        },
        peserta: pesertaList,
        penguji: pengujiList,
        kelompok: kelompokList,
        penilaian: penilaianMap,
        settings,
        meta: {
          note: `Cadangan manual dibuat oleh ${currentUser.displayName}`,
        },
      };

      await uploadJsonToDrive(
        accessToken,
        fileName,
        backupPayload,
        `Cadangan manual oleh ${currentUser.displayName}`
      );

      setSyncStatus('success');
      setSyncMessage(`Cadangan "${fileName}" berhasil disimpan di Google Drive!`);
      loadBackups(accessToken);
    } catch (err: any) {
      setSyncStatus('error');
      setErrorMessage(err.message || 'Gagal membuat cadangan ke Google Drive.');
    }
  };

  // ==========================================================
  // 4. PULIHKAN DARI FILE CADANGAN (RESTORE)
  // ==========================================================
  const triggerRestoreFile = (file: DriveFileInfo) => {
    setConfirmDialog({
      isOpen: true,
      title: `Konfirmasi Pemulihan: ${file.name}`,
      message: `Data aplikasi akan diperbarui dengan data dari file cadangan "${file.name}" (diperbarui: ${
        file.modifiedTime ? new Date(file.modifiedTime).toLocaleString('id-ID') : '-'
      }).`,
      warningText:
        'Anda dapat memilih untuk menggabungkan (Merge) agar data lokal tetap aman, atau menimpa penuh.',
      confirmButtonText: 'Pulihkan & Gabungkan (Merge)',
      onConfirm: async () => {
        setConfirmDialog(null);
        await executeRestoreFile(file);
      },
    });
  };

  const executeRestoreFile = async (file: DriveFileInfo) => {
    if (!currentUser) return;
    setSyncStatus('syncing');
    setSyncMessage(`Mengunduh file "${file.name}"...`);

    try {
      const accessToken = await getGoogleAccessToken();
      if (!accessToken) throw new Error('Token Google Drive tidak tersedia.');

      const remoteData = await downloadJsonFile<SyncPayload>(accessToken, file.id);
      if (!remoteData || !remoteData.peserta) {
        throw new Error('Format file cadangan tidak valid.');
      }

      // Merge and update
      const { merged, report } = mergeAndUpdateAppData(
        {
          peserta: pesertaList,
          penguji: pengujiList,
          kelompok: kelompokList,
          penilaian: penilaianMap,
          settings,
        },
        remoteData,
        currentUser,
        googleUser?.email || undefined
      );

      onApplySyncData(
        merged.peserta,
        merged.penguji,
        merged.kelompok,
        merged.penilaian,
        merged.settings
      );

      setLastReport(report);
      setSyncStatus('success');
      setSyncMessage(`Data berhasil dipulihkan dari "${file.name}"!`);
    } catch (err: any) {
      setSyncStatus('error');
      setErrorMessage(err.message || 'Gagal memulihkan file cadangan.');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-stone-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 print:hidden">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full p-5 sm:p-7 border border-stone-200 animate-in fade-in zoom-in-95 duration-150 max-h-[92vh] overflow-y-auto flex flex-col">
        {/* Header Modal */}
        <div className="flex items-center justify-between pb-4 border-b border-stone-200 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-700">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-black text-stone-900 tracking-tight uppercase">
                  Sinkronisasi Google Drive
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                  Folder Kwarran Kemranjen
                </span>
              </div>
              <p className="text-xs text-stone-500">
                Cadangkan, pulihkan, dan selaraskan data peserta &amp; penilaian secara aman
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Akun Google & Status Folder Banner */}
        <div className="my-4 p-4 rounded-xl bg-stone-50 border border-stone-200 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {googleUser ? (
              <>
                {googleUser.photoURL ? (
                  <img
                    src={googleUser.photoURL}
                    alt={googleUser.displayName || 'Google'}
                    className="w-10 h-10 rounded-full border border-stone-300 shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-800 font-bold flex items-center justify-center text-sm shrink-0">
                    {googleUser.displayName?.charAt(0) || 'G'}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-bold text-xs sm:text-sm text-stone-900 truncate">
                      {googleUser.displayName || 'Akun Google Terhubung'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded-md border border-emerald-200">
                      <CheckCircle2 className="w-3 h-3" />
                      Terhubung
                    </span>
                  </div>
                  <div className="text-[11px] text-stone-500 truncate">{googleUser.email}</div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-stone-200 flex items-center justify-center text-stone-500">
                  <Cloud className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-xs sm:text-sm text-stone-800">
                    Akun Google Belum Terhubung
                  </div>
                  <div className="text-[11px] text-stone-500">
                    Masuk dengan Google untuk menyinkronkan data ke Google Drive
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto justify-end">
            {googleUser ? (
              <button
                type="button"
                onClick={handleGoogleSignOut}
                className="px-3 py-1.5 rounded-lg border border-stone-300 hover:bg-stone-100 text-stone-700 text-xs font-semibold transition-colors"
              >
                Ganti Akun
              </button>
            ) : (
              /* Official Sign in with Google Button */
              <button
                type="button"
                disabled={isAuthenticating}
                onClick={handleGoogleSignIn}
                className="gsi-material-button w-full sm:w-auto px-4 py-2 bg-white hover:bg-stone-50 text-stone-800 font-semibold text-xs rounded-xl border border-stone-300 shadow-xs flex items-center justify-center gap-2.5 transition-all"
              >
                <svg
                  version="1.1"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 48 48"
                  className="w-4 h-4 shrink-0"
                >
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                  <path fill="none" d="M0 0h48v48H0z" />
                </svg>
                <span>{isAuthenticating ? 'Menghubungkan...' : 'Sign in with Google'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Folder Target Info Bar */}
        <div className="mb-4 p-3 rounded-xl bg-amber-50/70 border border-amber-200/80 flex items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FolderCheck className="w-4 h-4 text-amber-700 shrink-0" />
            <div className="min-w-0">
              <span className="font-bold text-stone-900">Folder Tujuan: </span>
              <span className="text-stone-700 font-mono text-[11px] truncate">
                {GOOGLE_DRIVE_FOLDER_ID}
              </span>
            </div>
          </div>

          <a
            href={GOOGLE_DRIVE_FOLDER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-bold text-amber-800 hover:text-amber-950 hover:underline shrink-0 text-[11px]"
          >
            <span>Buka di Google Drive</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        {/* Tab Navigasi Modal */}
        <div className="flex items-center gap-2 mb-4 p-1 bg-stone-100 rounded-xl border border-stone-200 shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('sync')}
            className={`flex-1 py-1.5 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'sync'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
            }`}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Sinkronisasi Data</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('backups');
              getGoogleAccessToken().then((t) => {
                if (t) loadBackups(t);
              });
            }}
            className={`flex-1 py-1.5 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'backups'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>Riwayat &amp; Cadangan</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('info')}
            className={`flex-1 py-1.5 px-3 text-xs sm:text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-1.5 ${
              activeTab === 'info'
                ? 'bg-amber-600 text-white shadow-xs'
                : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
            }`}
          >
            <Info className="w-3.5 h-3.5" />
            <span>Petunjuk &amp; Aturan</span>
          </button>
        </div>

        {/* Error message */}
        {errorMessage && (
          <div className="mb-4 p-3 rounded-xl bg-rose-50 border border-rose-200 flex items-start gap-2.5 text-xs text-rose-800 animate-in fade-in">
            <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1 font-medium">{errorMessage}</div>
          </div>
        )}

        {/* Sync Status Banner */}
        {syncStatus === 'syncing' && (
          <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-300 flex items-center gap-2.5 text-xs text-amber-900 animate-in fade-in">
            <RefreshCw className="w-4 h-4 text-amber-600 animate-spin shrink-0" />
            <div className="font-semibold">{syncMessage}</div>
          </div>
        )}

        {syncStatus === 'success' && (
          <div className="mb-4 p-3 rounded-xl bg-emerald-50 border border-emerald-300 flex items-center gap-2.5 text-xs text-emerald-900 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <div className="font-semibold">{syncMessage}</div>
          </div>
        )}

        {/* CONTENT TABS */}
        <div className="flex-1 overflow-y-auto space-y-4">
          {activeTab === 'sync' && (
            <div className="space-y-4">
              {/* OPSI 1: SINKRONISASI CERDAS (MERGE & UPDATE) - SEMUA USER */}
              <div className="p-4 sm:p-5 rounded-2xl border-2 border-amber-300/80 bg-gradient-to-br from-amber-50/50 to-white space-y-3.5 shadow-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-amber-600 text-white flex items-center justify-center shadow-xs">
                      <RefreshCw className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="font-black text-sm sm:text-base text-stone-900">
                        Sinkronisasi Cerdas (Merge &amp; Update)
                      </h4>
                      <p className="text-[11px] text-amber-900 font-semibold">
                        Aman untuk seluruh pengguna (Penguji &amp; Admin) • Data lama tidak pernah hilang
                      </p>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide bg-amber-200 text-amber-950">
                    Standar
                  </span>
                </div>

                <p className="text-xs text-stone-600 leading-relaxed">
                  Menggabungkan data lokal Anda dengan data di Google Drive secara otomatis. Peserta baru yang diinput rekan penguji lain akan ditambahkan ke sistem Anda, dan nilai yang baru saja Anda isi akan disimpan ke Google Drive tanpa menimpa atau menghapus data siapapun.
                </p>

                <div className="pt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={syncStatus === 'syncing'}
                    onClick={handleMergeAndUpdateSync}
                    className="px-4 py-2.5 bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-bold text-xs sm:text-sm rounded-xl shadow-md shadow-amber-600/20 flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
                    <span>Mulai Sinkronisasi (Merge &amp; Update)</span>
                  </button>

                  <button
                    type="button"
                    disabled={syncStatus === 'syncing'}
                    onClick={handleCreateManualBackup}
                    className="px-3.5 py-2.5 bg-stone-100 hover:bg-stone-200 text-stone-800 font-semibold text-xs sm:text-sm rounded-xl border border-stone-300 flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <UploadCloud className="w-4 h-4 text-stone-600" />
                    <span>Buat Cadangan File Baru</span>
                  </button>
                </div>
              </div>

              {/* OPSI 2: SINKRONISASI PENGHAPUSAN (KHUSUS ADMIN) */}
              <div
                className={`p-4 sm:p-5 rounded-2xl border ${
                  isAdmin
                    ? 'border-rose-300 bg-rose-50/30'
                    : 'border-stone-200 bg-stone-50/60 opacity-80'
                } space-y-3.5`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shadow-xs ${
                        isAdmin ? 'bg-rose-600 text-white' : 'bg-stone-400 text-white'
                      }`}
                    >
                      <ShieldAlert className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <h4 className="font-black text-sm sm:text-base text-stone-900">
                          Sinkronisasi Penghapusan (Admin Master Override)
                        </h4>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-black uppercase ${
                            isAdmin
                              ? 'bg-rose-100 text-rose-800 border border-rose-300'
                              : 'bg-stone-200 text-stone-600'
                          }`}
                        >
                          Khusus Admin
                        </span>
                      </div>
                      <p className="text-[11px] text-stone-500 font-medium">
                        Menyesuaikan Google Drive agar selaras dengan data lokal yang telah Anda hapus
                      </p>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-stone-600 leading-relaxed">
                  Jika Anda sebagai Admin telah menghapus peserta yang batal hadir, data penguji lama, atau data tim penilai, gunakan fitur ini untuk memastikan data yang terhapus tersebut juga ikut dihapus di Google Drive.
                </p>

                {isAdmin ? (
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={syncStatus === 'syncing'}
                      onClick={triggerAdminDeletionSync}
                      className="px-4 py-2.5 bg-rose-600 hover:bg-rose-700 active:scale-95 text-white font-bold text-xs sm:text-sm rounded-xl shadow-md shadow-rose-600/20 flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
                    >
                      <ShieldAlert className="w-4 h-4" />
                      <span>Sinkronisasikan Penghapusan ke Google Drive</span>
                    </button>
                    <p className="text-[11px] text-stone-500 mt-2">
                      * Sistem akan otomatis membuat file snapshot cadangan darurat di Google Drive sebelum proses penghapusan dilakukan.
                    </p>
                  </div>
                ) : (
                  <div className="p-2.5 rounded-lg bg-stone-100 text-[11px] text-stone-600 flex items-center gap-2">
                    <Info className="w-3.5 h-3.5 text-stone-500 shrink-0" />
                    <span>
                      Anda sedang login sebagai <strong>Penguji</strong>. Opsi penyesuaian penghapusan hanya dapat diakses oleh Administrator Kwarcab untuk mencegah data terhapus tanpa sengaja.
                    </span>
                  </div>
                )}
              </div>

              {/* LAPORAN HASIL SINKRONISASI TERAKHIR */}
              {lastReport && (
                <div className="p-4 rounded-xl bg-stone-50 border border-stone-200 space-y-3 animate-in fade-in">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-xs font-black text-stone-900 uppercase tracking-wide">
                      <Sparkles className="w-4 h-4 text-amber-600" />
                      <span>Rincian Hasil Sinkronisasi</span>
                    </div>
                    <span className="text-[10px] text-stone-500 font-mono">
                      {new Date(lastReport.timestamp).toLocaleTimeString('id-ID')}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Peserta</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.peserta.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.peserta.added} baru • {lastReport.peserta.updated} diupdate
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Penguji</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.penguji.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.penguji.added} baru • {lastReport.penguji.updated} diupdate
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Tim Penilai</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.kelompok.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.kelompok.added} baru • {lastReport.kelompok.updated} diupdate
                      </div>
                    </div>

                    <div className="p-2.5 rounded-lg bg-white border border-stone-200">
                      <div className="text-[10px] text-stone-500 font-semibold uppercase">Penilaian</div>
                      <div className="text-base font-black text-stone-900">
                        {lastReport.penilaian.total}
                      </div>
                      <div className="text-[10px] text-emerald-700 font-medium">
                        +{lastReport.penilaian.added} baru • {lastReport.penilaian.updated} diupdate
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'backups' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-stone-200">
                <div className="text-xs font-bold text-stone-800 uppercase tracking-wide">
                  Daftar File Cadangan di Folder Drive
                </div>
                <button
                  type="button"
                  disabled={loadingBackups}
                  onClick={() => loadBackups()}
                  className="text-xs text-amber-700 hover:text-amber-900 font-bold flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingBackups ? 'animate-spin' : ''}`} />
                  <span>Segarkan</span>
                </button>
              </div>

              {loadingBackups ? (
                <div className="py-8 text-center text-xs text-stone-500 flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-amber-600" />
                  <span>Memuat daftar cadangan dari Google Drive...</span>
                </div>
              ) : backupFiles.length === 0 ? (
                <div className="py-8 text-center text-xs text-stone-500">
                  <FileJson className="w-8 h-8 mx-auto text-stone-400 mb-2" />
                  <p>Belum ada file cadangan di folder Google Drive ini.</p>
                  <button
                    type="button"
                    onClick={handleCreateManualBackup}
                    className="mt-3 px-3 py-1.5 bg-amber-600 text-white rounded-lg font-bold text-xs inline-flex items-center gap-1"
                  >
                    <UploadCloud className="w-3.5 h-3.5" />
                    <span>Buat Cadangan Pertama Sekarang</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {backupFiles.map((file) => {
                    const isMaster = file.name === MASTER_SYNC_FILENAME;
                    return (
                      <div
                        key={file.id}
                        className={`p-3 rounded-xl border flex items-center justify-between gap-3 ${
                          isMaster
                            ? 'border-amber-300 bg-amber-50/40'
                            : 'border-stone-200 bg-white hover:bg-stone-50'
                        }`}
                      >
                        <div className="min-w-0 flex items-center gap-3">
                          <div
                            className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                              isMaster
                                ? 'bg-amber-600 text-white'
                                : 'bg-stone-100 text-stone-600 border border-stone-200'
                            }`}
                          >
                            <FileJson className="w-4 h-4" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-xs text-stone-900 truncate">
                                {file.name}
                              </span>
                              {isMaster && (
                                <span className="px-1.5 py-0.2 bg-amber-200 text-amber-900 text-[9px] font-black rounded-sm uppercase">
                                  Master Data
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-stone-500 flex items-center gap-2">
                              <span>
                                {file.modifiedTime
                                  ? new Date(file.modifiedTime).toLocaleString('id-ID')
                                  : '-'}
                              </span>
                              {file.description && (
                                <span className="truncate max-w-[200px] text-stone-400">
                                  • {file.description}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="shrink-0 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => triggerRestoreFile(file)}
                            className="px-2.5 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-800 text-xs font-bold transition-colors flex items-center gap-1 cursor-pointer"
                            title="Pulihkan dan gabungkan data dari file ini"
                          >
                            <DownloadCloud className="w-3.5 h-3.5 text-amber-700" />
                            <span>Pulihkan (Restore)</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'info' && (
            <div className="space-y-4 text-xs text-stone-700 leading-relaxed">
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 space-y-1.5">
                <div className="font-black text-amber-950 uppercase tracking-wide flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-700" />
                  <span>Prinsip Kerja Sinkronisasi (Merge &amp; Update)</span>
                </div>
                <p>
                  Setiap penguji dapat menilai anak didik secara independen menggunakan perangkat laptop, tablet, atau handphone masing-masing. Saat menekan tombol <strong>Mulai Sinkronisasi</strong>:
                </p>
                <ul className="list-disc pl-5 space-y-1 mt-1 text-stone-700 font-medium">
                  <li>Nilai wawancara dan administrasi yang Anda input akan diunggah ke Google Drive.</li>
                  <li>Nilai yang diinput oleh rekan penguji lain untuk peserta lain akan otomatis ditarik dan disatukan ke aplikasi Anda.</li>
                  <li>Data peserta lama tidak akan terhapus ataupun tertimpa kosong.</li>
                </ul>
              </div>

              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 space-y-1.5">
                <div className="font-black text-rose-950 uppercase tracking-wide flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-rose-700" />
                  <span>Kewenangan Khusus Administrator (Penghapusan)</span>
                </div>
                <p>
                  Jika ada peserta yang dibatalkan pendaftarannya atau data ganda yang dihapus oleh Administrator Kwarcab, gunakan menu <strong>Sinkronisasi Penghapusan</strong> untuk membersihkan data tersebut di cloud.
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-stone-100 border border-stone-200 space-y-1 text-stone-600">
                <div className="font-bold text-stone-900">Folder Resmi Google Drive:</div>
                <div className="font-mono text-[11px] text-amber-900 break-all select-all">
                  {GOOGLE_DRIVE_FOLDER_URL}
                </div>
                <div className="pt-1 text-[11px]">
                  Folder ini dapat dibuka langsung oleh panitia untuk melihat cadangan file JSON atau membagikan akses ke penguji lain.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer Modal */}
        <div className="pt-4 border-t border-stone-200 flex items-center justify-between shrink-0">
          <div className="text-[11px] text-stone-500">
            Kwartir Ranting Kemranjen • Kwartir Cabang Banyumas
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-800 font-bold text-xs sm:text-sm rounded-xl transition-colors cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>

      {/* CONFIRMATION MODAL FOR DESTRUCTIVE / ADMIN OPERATIONS (MANDATORY PER POLICY) */}
      {confirmDialog && confirmDialog.isOpen && (
        <div className="fixed inset-0 z-60 bg-stone-950/80 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-stone-300 animate-in fade-in zoom-in-95 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-black text-base text-stone-900">{confirmDialog.title}</h4>
                <p className="text-xs text-stone-600 mt-1 leading-relaxed">{confirmDialog.message}</p>
              </div>
            </div>

            {confirmDialog.warningText && (
              <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-[11px] text-rose-800 font-semibold leading-relaxed">
                {confirmDialog.warningText}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-stone-200">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 font-bold text-xs rounded-xl transition-colors cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => confirmDialog.onConfirm()}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-black text-xs rounded-xl shadow-md shadow-rose-600/20 transition-all cursor-pointer"
              >
                {confirmDialog.confirmButtonText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
