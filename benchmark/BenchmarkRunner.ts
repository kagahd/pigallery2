import {Config} from '../src/common/config/private/Config';
import {ObjectManagers} from '../src/backend/model/ObjectManagers';
import {DiskMangerWorker} from '../src/backend/model/threading/DiskMangerWorker';
import {IndexingManager} from '../src/backend/model/database/sql/IndexingManager';
import {SearchManager} from '../src/backend/model/database/sql/SearchManager';
import * as util from 'util';
import * as path from 'path';
import * as rimraf from 'rimraf';
import {SearchTypes} from '../src/common/entities/AutoCompleteItem';
import {Utils} from '../src/common/Utils';
import {DirectoryDTO} from '../src/common/entities/DirectoryDTO';
import {ServerConfig} from '../src/common/config/private/PrivateConfig';
import {ProjectPath} from '../src/backend/ProjectPath';
import {PersonMWs} from '../src/backend/middlewares/PersonMWs';
import {ThumbnailGeneratorMWs} from '../src/backend/middlewares/thumbnail/ThumbnailGeneratorMWs';
import {Benchmark} from './Benchmark';
import {IndexingJob} from '../src/backend/model/jobs/jobs/IndexingJob';
import {IJob} from '../src/backend/model/jobs/jobs/IJob';
import {JobProgressStates} from '../src/common/entities/job/JobProgressDTO';
import {JobProgress} from '../src/backend/model/jobs/jobs/JobProgress';
import {GalleryMWs} from '../src/backend/middlewares/GalleryMWs';
import {UserDTO, UserRoles} from '../src/common/entities/UserDTO';
import {ContentWrapper} from '../src/common/entities/ConentWrapper';
import {GalleryManager} from '../src/backend/model/database/sql/GalleryManager';
import {PersonManager} from '../src/backend/model/database/sql/PersonManager';

const rimrafPR = util.promisify(rimraf);

export interface BenchmarkResult {
  name: string;
  duration: number;
  contentWrapper?: ContentWrapper;
  items?: number;
  subBenchmarks?: BenchmarkResult[];
}

export class BMIndexingManager extends IndexingManager {

  public async saveToDB(scannedDirectory: DirectoryDTO): Promise<void> {
    return super.saveToDB(scannedDirectory);
  }
}

export class BenchmarkRunner {
  inited = false;
  private biggestPath: string = null;

  constructor(public RUNS: number) {

  }

  async bmSaveDirectory(): Promise<BenchmarkResult> {
    await this.init();
    await this.resetDB();
    const dir = await DiskMangerWorker.scanDirectory(this.biggestPath);
    const bm = new Benchmark('Saving directory to DB', null, () => this.resetDB());
    bm.addAStep({
      name: 'Saving directory to DB',
      fn: () => {
        const im = new BMIndexingManager();
        return im.saveToDB(dir);
      }
    });
    return await bm.run(this.RUNS);
  }

  async bmScanDirectory(): Promise<BenchmarkResult> {
    await this.init();
    const bm = new Benchmark('Scanning directory');
    bm.addAStep({
      name: 'Scanning directory',
      fn: async () => new ContentWrapper(await DiskMangerWorker.scanDirectory(this.biggestPath))
    });
    return await bm.run(this.RUNS);
  }

  async bmListDirectory(): Promise<BenchmarkResult> {
    await this.init();
    await this.setupDB();
    Config.Server.Indexing.reIndexingSensitivity = ServerConfig.ReIndexingSensitivity.low;
    const bm = new Benchmark('List directory',
      null,
      async () => {
        await ObjectManagers.reset();
        await ObjectManagers.InitSQLManagers();
      });
    bm.addAStep({
      name: 'List directory',
      fn: (input) => this.nextToPromise(GalleryMWs.listDirectory, input, {directory: this.biggestPath})
    });
    bm.addAStep({
      name: 'Add Thumbnail information',
      fn: (input) => this.nextToPromise(ThumbnailGeneratorMWs.addThumbnailInformation, input)
    });
    bm.addAStep({
      name: 'Clean Up Gallery Result',
      fn: (input) => this.nextToPromise(GalleryMWs.cleanUpGalleryResults, input)
    });
    return await bm.run(this.RUNS);
  }

  async bmListPersons(): Promise<BenchmarkResult> {
    await this.setupDB();
    Config.Server.Indexing.reIndexingSensitivity = ServerConfig.ReIndexingSensitivity.low;
    const bm = new Benchmark('Listing Faces', null, async () => {
      await ObjectManagers.reset();
      await ObjectManagers.InitSQLManagers();
    });
    bm.addAStep({
      name: 'List Persons',
      fn: (input) => this.nextToPromise(PersonMWs.listPersons, input)
    });
    bm.addAStep({
      name: 'Add sample photo',
      fn: (input) => this.nextToPromise(PersonMWs.addSamplePhotoForAll, input)
    });
    bm.addAStep({
      name: 'Add thumbnail info',
      fn: (input) => this.nextToPromise(ThumbnailGeneratorMWs.addThumbnailInfoForPersons, input)
    });
    bm.addAStep({
      name: 'Remove sample photo',
      fn: (input) => this.nextToPromise(PersonMWs.removeSamplePhotoForAll, input)
    });
    return await bm.run(this.RUNS);
  }

  async bmAllSearch(text: string): Promise<{ result: BenchmarkResult, searchType: SearchTypes }[]> {
    await this.setupDB();
    const types = Utils.enumToArray(SearchTypes).map(a => a.key).concat([null]);
    const results: { result: BenchmarkResult, searchType: SearchTypes }[] = [];

    for (let i = 0; i < types.length; i++) {
      const bm = new Benchmark('Searching');
      bm.addAStep({
        name: 'Searching',
        fn: async () => {
          const sm = new SearchManager();
          return new ContentWrapper(null, await sm.search(text, types[i]));
        }
      });
      results.push({result: await bm.run(this.RUNS), searchType: types[i]});
    }
    return results;
  }

  async bmInstantSearch(text: string): Promise<BenchmarkResult> {
    await this.setupDB();
    const bm = new Benchmark('Instant search');
    bm.addAStep({
      name: 'Instant search',
      fn: async () => {
        const sm = new SearchManager();
        return new ContentWrapper(null, await sm.instantSearch(text));
      }
    });
    return await bm.run(this.RUNS);
  }

  async bmAutocomplete(text: string): Promise<BenchmarkResult> {
    await this.setupDB();
    const bm = new Benchmark('Auto complete');
    bm.addAStep({
      name: 'Auto complete',
      fn: () => {
        const sm = new SearchManager();
        return sm.autocomplete(text);
      }
    });
    return await bm.run(this.RUNS);
  }

  async getStatistic() {
    await this.setupDB();
    const gm = new GalleryManager();
    const pm = new PersonManager();

    const renderDataSize = (size: number) => {
      const postFixes = ['B', 'KB', 'MB', 'GB', 'TB'];
      let index = 0;
      while (size > 1000 && index < postFixes.length - 1) {
        size /= 1000;
        index++;
      }
      return size.toFixed(2) + postFixes[index];
    };
    return 'directories: ' + await gm.countDirectories() +
      ', photos: ' + await gm.countPhotos() +
      ', videos: ' + await gm.countVideos() +
      ', diskUsage : ' + renderDataSize(await gm.countMediaSize()) +
      ', persons : ' + await pm.countFaces() +
      ', unique persons (faces): ' + (await pm.getAll()).length;

  }

  private async init() {
    if (this.inited === false) {
      await this.setupDB();

      const gm = new GalleryManager();
      let biggest = 0;
      let biggestPath = '/';
      const queue = ['/'];
      while (queue.length > 0) {
        const dirPath = queue.shift();
        const dir = await gm.listDirectory(dirPath);
        dir.directories.forEach(d => queue.push(path.join(d.path + d.name)));
        if (biggest < dir.media.length) {
          biggestPath = path.join(dir.path + dir.name);
          biggest = dir.media.length;
        }
      }
      this.biggestPath = biggestPath;
      console.log('updating path of biggest dir to: ' + this.biggestPath);
      this.inited = true;
    }
    return this.biggestPath;

  }

  private nextToPromise(fn: (req: any, res: any, next: Function) => void, input?: any, params = {}) {
    return new Promise<void>((resolve, reject) => {
      const request = {
        resultPipe: input,
        params: params,
        query: {},
        session: {user: <UserDTO>{name: UserRoles[UserRoles.Admin], role: UserRoles.Admin}}
      };
      fn(request, resolve, (err?: any) => {
        if (err) {
          return reject(err);
        }
        resolve(request.resultPipe);
      });
    });
  }

  private resetDB = async () => {
    Config.Server.Threading.enabled = false;
    await ObjectManagers.reset();
    await rimrafPR(ProjectPath.DBFolder);
    Config.Server.Database.type = ServerConfig.DatabaseType.sqlite;
    Config.Server.Jobs.scheduled = [];
    await ObjectManagers.InitSQLManagers();
  };

  private setupDB(): Promise<void> {
    Config.Server.Threading.enabled = false;
    return new Promise<void>(async (resolve, reject) => {
      try {
        await this.resetDB();
        const indexingJob = new IndexingJob();

        indexingJob.JobListener = {
          onJobFinished: (job: IJob<any>, state: JobProgressStates, soloRun: boolean) => {
            resolve();
          },

          onProgressUpdate: (progress: JobProgress) => {
          }
        };
        indexingJob.start().catch(console.error);
      } catch (e) {
        console.error(e);
        reject(e);
      }
    });
  }
}