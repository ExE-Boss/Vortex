import path from 'path';

import * as types from '../../types/api';
import { COMPANY_ID } from '../../util/constants';
import * as fs from '../../util/fs';
import { log } from '../../util/log';
import { generate, Interface, parser } from './collections/loadOrder';

import { ICollectionsGameSupportEntry } from './types/collections';
import { ILoadOrderGameInfo, ILoadOrderGameInfoExt } from './types/types';

const gameSupport: ILoadOrderGameInfoExt[] = [];
export function addGameEntry(gameEntry: ILoadOrderGameInfo, extPath: string) {
  if (gameEntry === undefined) {
    log('error', 'unable to add load order page - invalid game entry');
    return;
  }

  const isDuplicate: boolean = gameSupport.find(game =>
    game.gameId === gameEntry.gameId) !== undefined;

  if (isDuplicate) {
    log('debug', 'attempted to add duplicate gameEntry to load order extension', gameEntry.gameId);
    return;
  }

  // The LO page registration can be done as an "addon" through
  //  another extension - which means we could have an officially supported
  //  game extension but an unofficial load order registration so checking if
  //  game.contributed === undefined is not sufficient - we need to read the
  //  info.json file of the extension that registers the LO page.
  const gameExtInfo = JSON.parse(
    fs.readFileSync(path.join(extPath, 'info.json'), { encoding: 'utf8' }));

  gameSupport.push({ ...gameEntry, isContributed: gameExtInfo.author !== COMPANY_ID });
}

export function findGameEntry(gameId: string): ILoadOrderGameInfoExt {
  return gameSupport.find(game => game.gameId === gameId);
}

export function initCollectionsSupport(api: types.IExtensionApi) {
  if (api.ext.addGameSpecificCollectionsData !== undefined) {
    for (const game of gameSupport) {
      if (game.noCollectionGeneration === true) {
        continue;
      }
      const collectionsSupportEntry: ICollectionsGameSupportEntry = {
        gameId: game.gameId,
        generator: (state, gameId, stagingPath, modIds, mods) =>
          generate(api, state, gameId, stagingPath, modIds, mods),
        parser,
        interface: Interface,
      };

      api.ext.addGameSpecificCollectionsData(collectionsSupportEntry);
    }
  }
}