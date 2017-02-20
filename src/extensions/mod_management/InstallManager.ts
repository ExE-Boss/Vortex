import {showDialog} from '../../actions/notifications';
import {IDialogResult} from '../../types/IDialog';
import {IExtensionApi} from '../../types/IExtensionContext';
import {log} from '../../util/log';
import {activeGameId, downloadPath} from '../../util/selectors';

import {IDownload} from '../download_management/types/IDownload';

import {IDependency} from './types/IDependency';
import {IInstall} from './types/IInstall';
import {IModInstaller} from './types/IModInstaller';
import {ISupportedResult, ITestSupported} from './types/ITestSupported';
import gatherDependencies from './util/dependencies';
import filterModInfo from './util/filterModInfo';

import InstallContext from './InstallContext';

import * as Promise from 'bluebird';
import * as fs from 'fs-extra-promise';
import {ILookupResult, IReference, IRule} from 'modmeta-db';
import Zip = require('node-7z');
import * as path from 'path';
import {dir as tmpDir, file as tmpFile} from 'tmp';

interface IZipEntry {
  date: Date;
  attr: string;
  size: number;
  name: string;
}

interface ISupportedInstaller {
  installer: IModInstaller;
  requiredFiles: string[];
}

interface IInstruction {
  type: 'copy' | 'submodule';

  path: string;
  source: string;
  destination: string;
}

// tslint:disable-next-line:no-empty
function UserCanceled() {}

/**
 * central class for the installation process
 * 
 * @class InstallManager
 */
class InstallManager {
  private mInstallers: IModInstaller[] = [];
  private mGetInstallPath: () => string;
  private mTask = new Zip();

  constructor(installPath: () => string) { this.mGetInstallPath = installPath; }

  /**
   * add an installer extension
   * 
   * @param {number} priority priority of the installer. the lower the number the higher
   *                          the priority, so at priority 0 the extension would always be
   *                          the first to be queried
   * @param {ITestSupported} testSupported
   * @param {IInstall} install
   * 
   * @memberOf InstallManager
   */
  public addInstaller(priority: number, testSupported: ITestSupported,
                      install: IInstall) {
    this.mInstallers.push({priority, testSupported, install});
    this.mInstallers.sort((lhs: IModInstaller, rhs: IModInstaller): number => {
      return lhs.priority - rhs.priority;
    });
  }

  /**
   * start installing a mod.
   *
   * @param {string} archiveId id of the download. may be null if the download isn't
   *                           in our download archive
   * @param {string} archivePath path to the archive file
   * @param {string} installPath path to install mods into (not including the
   * mod name)
   * @param {IExtensionContext} context extension context
   * @param {*} info existing information about the mod (i.e. stuff retrieved
   *                 from the download page)
   */
  public install(archiveId: string,
                 archivePath: string,
                 gameId: string,
                 api: IExtensionApi,
                 info: any, processDependencies: boolean,
                 callback?: (error: Error, id: string) => void) {
    const installContext = new InstallContext(gameId, api.store.dispatch);

    const baseName = path.basename(archivePath, path.extname(archivePath));
    let installName = baseName;
    let fullInfo = Object.assign({}, info);

    installContext.startIndicator(baseName);

    let destinationPath: string;

    api.lookupModMeta({filePath: archivePath})
        .then((modInfo: ILookupResult[]) => {
          if (modInfo.length > 0) {
            fullInfo.meta = modInfo[0].value;
          }

          installName = this.deriveInstallName(baseName, fullInfo);

          const checkNameLoop = () => {
            return this.checkModExists(installName, api, gameId) ?
                       this.queryUserReplace(installName, api)
                           .then((newName: string) => {
                             installName = newName;
                             return checkNameLoop();
                           }) :
                       Promise.resolve(installName);
          };

          return checkNameLoop();
        })
        .then(() => {
          installContext.startInstallCB(installName, archiveId);

          destinationPath = path.join(this.mGetInstallPath(), installName);
          return this.installInner(archivePath, gameId);
        })
        .then((result) => {
          installContext.setInstallPathCB(installName, destinationPath);
          return this.processInstructions(archivePath, destinationPath, gameId, result);
        })
        .then(() => {
          const filteredInfo = filterModInfo(fullInfo);
          installContext.finishInstallCB(installName, true, filteredInfo);
          if (processDependencies) {
            this.installDependencies(filteredInfo.rules, this.mGetInstallPath(),
                                     installContext, api);
          }
          if (callback !== undefined) {
            callback(null, installName);
          }
        })
        .catch((err) => {
          installContext.finishInstallCB(installName, false);
          if (!(err instanceof UserCanceled)) {
            installContext.reportError('Installation failed', err);
            if (callback !== undefined) {
              callback(err, installName);
            }
          }
        })
        .finally(() => { installContext.stopIndicator(baseName); });
  }

  /**
   * find the right installer for the specified archive, then install
   */
  private installInner(archivePath: string, gameId: string) {
    let fileList: IZipEntry[] = [];
    // get list of files in the archive
    return new Promise((resolve, reject) => {
             this.mTask.list(archivePath, {})
                 .progress((files: any[]) => {
                   fileList.push(
                       ...files.filter((spec) => spec.attr[0] !== 'D'));
                 })
                 .then(() => { resolve(); });
           })
        .then(() => this.getInstaller(
                  fileList.map((entry: IZipEntry) => entry.name)))
        .then((supportedInstaller: ISupportedInstaller) => {
          if (supportedInstaller === undefined) {
            throw new Error('no installer supporting this file');
          }
          const {installer, requiredFiles} = supportedInstaller;
          let cleanup: () => void;
          let reqFilesPath: string;
          // extract the requested files, then initiate the actual install
          return new Promise<string>((resolve, reject) => {
                   tmpDir({unsafeCleanup: true},
                          (err: any, tmpPath: string,
                           cleanupCallback: () => void) => {
                            if (err !== null) {
                              reject(err);
                            }
                            cleanup = cleanupCallback;
                            resolve(tmpPath);
                          });
                 })
              .then((tmpPath: string) => {
                reqFilesPath = tmpPath;
                if (requiredFiles.length > 0) {
                  return this.mTask.extractFull(archivePath, tmpPath, {
                    raw: requiredFiles,
                  });
                }
              })
              .then(() => installer.install(
                        fileList.map((entry: IZipEntry) => entry.name),
                        reqFilesPath, gameId,
                        (perc: number) => log('info', 'progress', perc)))
              .finally(() => {
                if (cleanup !== undefined) {
                  // cleanup();
                }
              });
        });
  }

  private processInstructions(archivePath: string, destinationPath: string,
                              gameId: string,
                              result: {instructions: IInstruction[]}) {
    if ((result.instructions === null) || (result.instructions === undefined) ||
        (result.instructions.length === 0)) {
      return Promise.reject('installer returned no instructions');
    }
    const copies = result.instructions.filter((instruction) =>
                                                  instruction.type === 'copy');

    const subModule = result.instructions.filter(
        (instruction) => instruction.type === 'submodule');

    return this.extractArchive(archivePath, destinationPath, copies)
        .then(() => Promise.each(
                  subModule,
                  (mod) => this.installInner(mod.path, gameId)
                               .then((resultInner) => this.processInstructions(
                                         archivePath, destinationPath, gameId,
                                         resultInner))));
  }

  private checkModExists(installName: string, api: IExtensionApi, gameMode: string): boolean {
    return installName in (api.store.getState().persistent.mods[gameMode] || {});
  }

  private queryUserReplace(modId: string, api: IExtensionApi): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      api.store
          .dispatch(showDialog(
              'question', 'Mod exists',
              {
                message:
                    'This mod seems to be installed already. You can replace the ' +
                    'existing one or install the new one under a different name ' +
                    '(this name is used internally, you can still change the display name ' +
                    'to anything you want).',
                formcontrol: [{
                  id: 'newName',
                  type: 'input',
                  value: modId,
                  label: 'Name',
                }],
              },
              {
                Cancel: null,
                Replace: null,
                Rename: null,
              }))
          .then((result: IDialogResult) => {
            if (result.action === 'Cancel') {
              reject(new UserCanceled());
            } else if (result.action === 'Rename') {
              resolve(result.input.value);
            } else if (result.action === 'Replace') {
              api.events.emit('remove-mod', modId, (err) => {
                if (err !== null) {
                  reject(err);
                } else {
                  resolve(modId);
                }
              });
            }
          });
    });
  }

  private getInstaller(fileList: string[],
                       offsetIn?: number): Promise<ISupportedInstaller> {
    let offset = offsetIn || 0;
    if (offset >= this.mInstallers.length) {
      return Promise.resolve(undefined);
    }
    return this.mInstallers[offset].testSupported(fileList).then(
        (testResult: ISupportedResult) => {
          if (testResult.supported === true) {
            return Promise.resolve({
              installer: this.mInstallers[offset],
              requiredFiles: testResult.requiredFiles,
            });
          } else {
            return this.getInstaller(fileList, offset + 1);
          }
        }).catch((err) => {
          log('warn', 'failed to test installer support', err.message);
          return this.getInstaller(fileList, offset + 1);
        });
  }

  /**
   * determine the mod name (on disk) from the archive path
   * TODO: this currently simply uses the archive name which should be fine
   *   for downloads from nexus but in general we need the path to encode the
   *   mod, the specific "component" and the version. And then we need to avoid
   *   collisions.
   *   Finally, the way I know users they will want to customize this.
   *
   * @param {string} archiveName
   * @param {*} info
   * @returns
   */
  private deriveInstallName(archiveName: string, info: any) {
    return archiveName;
  }

  private downloadModAsync(requirement: IReference, sourceURI: string,
                           api: IExtensionApi): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!api.events.emit('start-download', [sourceURI], {},
                                   (error, id) => {
                                     if (error === null) {
                                       resolve(id);
                                     } else {
                                       reject(error);
                                     }
                                   })) {
        reject(new Error('download manager not installed?'));
      }
    });
  }

  private doInstallDependencies(dependencies: IDependency[],
                                api: IExtensionApi): Promise<void> {
    return Promise.all(dependencies.map((dep: IDependency) => {
                    if (dep.download === undefined) {
                      return this.downloadModAsync(
                                     dep.reference,
                                     dep.lookupResults[0].value.sourceURI,
                                     api)
                          .then((downloadId: string) => {
                            return this.installModAsync(dep.reference, api,
                                                        downloadId);
                          });
                    } else {
                      return this.installModAsync(dep.reference, api,
                                                  dep.download);
                    }
                  }))
        .catch((err) => {
          api.showErrorNotification('Failed to install dependencies',
                                            err.message);
        })
        .then(() => undefined);
  }

  private installDependencies(rules: IRule[], installPath: string,
                              installContext: InstallContext,
                              api: IExtensionApi): Promise<void> {
    let notificationId = `${installPath}_activity`;
    api.sendNotification({
      id: notificationId,
      type: 'activity',
      message: 'Checking dependencies',
    });
    return gatherDependencies(rules, api)
        .then((dependencies: IDependency[]) => {
          api.dismissNotification(notificationId);

          if (dependencies.length === 0) {
            return Promise.resolve();
          }

          let requiredDownloads =
              dependencies.reduce((prev: number, current: IDependency) => {
                return prev + (current.download ? 0 : 1);
              }, 0);

          return new Promise<void>((resolve, reject) => {
            let message =
                `This mod has unresolved dependencies. ${dependencies.length} mods have to be
installed, ${requiredDownloads} of them have to be downloaded first.`;

            api.store.dispatch(
                showDialog('question', 'Install Dependencies', {message}, {
                  "Don't install": null,
                  Install:
                      () => this.doInstallDependencies(dependencies, api),
                }));
          });
        })
        .catch((err) => {
          api.dismissNotification(notificationId);
          api.showErrorNotification('Failed to check dependencies', err);
        });
  }

  private installModAsync(requirement: IReference, api: IExtensionApi,
                          downloadId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const state = api.store.getState();
      let download: IDownload = state.persistent.downloads.files[downloadId];
      let fullPath: string = path.join(downloadPath(state), download.localPath);
      this.install(downloadId, fullPath, download.game || activeGameId(state),
                   api, download.modInfo, false, (error, id) => {
                     if (error === null) {
                       resolve(id);
                     } else {
                       reject(error);
                     }
                   });
    });
  }
  /**
   * extract an archive
   *
   * @export
   * @param {string} archivePath path to the archive file
   * @param {string} destinationPath path to install to
   */
  private extractArchive(archivePath: string,
                         destinationPath: string,
                         copies: IInstruction[]): Promise<void> {
    if (copies.length === 0) {
      return Promise.resolve();
    }
    const extract7z = this.mTask.extractFull;

    let extractFilePath: string;

    return new Promise<string>((resolve, reject) => {
      tmpFile({ keep: true } as any,
        (err: any, tmpPath: string, fd: number,
          cleanupCB: () => void) => {
          if (err !== null) {
            reject(err);
          } else {
            fs.closeAsync(fd)
            .then(() => resolve(tmpPath));
          }
        });
    })
      .then((tmpPath: string) => {
        extractFilePath = tmpPath;
        const extractList: string[] = copies.map((instruction) => '"' + instruction.source + '"');
        return fs.writeFileAsync(tmpPath, extractList.join('\n'));
      })
      .then(() => extract7z(archivePath, destinationPath + '.installing',
        { raw: [`-ir@${extractFilePath}`] })
        .then((args: string[]) => {
          return fs.renameAsync(destinationPath + '.installing',
            destinationPath);
        }))
      .then(() => {
        // TODO hack: the 7z command line doesn't allow files to be renamed during installation so
        //  we extract them all and then rename. This also tries to clean up dirs that are empty
        //  afterwards but ideally we get a proper 7z lib...
        let renames =
          copies.filter((inst) => inst.source !== inst.destination);
        let affectedDirs = new Set<string>();
        return Promise.map(renames,
          (inst: any) => {
            const source = path.join(destinationPath, inst.source);
            const dest = path.join(destinationPath, inst.destination);
            let affDir = path.dirname(source);
            while (affDir.length > destinationPath.length) {
              affectedDirs.add(affDir);
              affDir = path.dirname(affDir);
            }
            return fs.ensureDirAsync(path.dirname(dest))
              .then(() => fs.renameAsync(source, dest));
          })
          .then(() => Promise.each(Array.from(affectedDirs).sort(
            (lhs: string, rhs: string) => rhs.length - lhs.length), (affectedPath: string) => {
            return fs.rmdirAsync(affectedPath).catch();
          }));
      })
      .then(() => undefined)
      .finally(() => {
        return fs.unlinkAsync(extractFilePath);
      });
  }
}

export default InstallManager;
