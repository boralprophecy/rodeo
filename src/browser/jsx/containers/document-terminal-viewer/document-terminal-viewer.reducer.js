import _ from 'lodash';
import mapReducers from '../../services/map-reducers';
import reduxUtil from '../../services/redux-util';
import promptViewerReducer from '../prompt-viewer/prompt-viewer.reducer';
import textUtil from '../../services/text-util';
import promptActionService from '../../services/prompt-actions';

const prefix = reduxUtil.fromFilenameToPrefix(__filename),
  responseTypeHandlers = {
    display_data: function (state, result) {
      const data = _.get(result, 'content.data');

      if (data) {
        state = addHistoryItem(state, {data, type: 'annotation'});
      }

      return state;
    },
    error: function (state, result) {
      const converter = textUtil.getAsciiToHtmlStream(),
        responseMsgId = _.get(result, 'parent_header.msg_id'),
        name = _.get(result, 'content.ename'),
        value = _.get(result, 'content.evalue'),
        traceback = _.get(result, 'content.traceback'),
        stacktrace = traceback.map(line => converter.toHtml(line));

      state = addHistoryItem(state, {name, stacktrace, traceback, type: 'pythonError', value});

      if (state.actives[responseMsgId]) {
        state = state.updateIn(['actives', responseMsgId], active => {
          const errors = active.errors && active.errors.asMutable() || [];

          active.set('errors', errors.concat([name, value, traceback]));

          return active;
        });
      }

      return state;
    },
    execute_input: function (state, result) {
      let source = _.get(result, 'content.name'),
        text = _.get(result, 'content.code'),
        html;

      if (state.promptLabel) {
        text = text.split('\n').map((value, index) => {
          return index === 0 ? state.promptLabel + value : (state.continueLabel || state.promptLabel) + value;
        }).join('\n');
      }

      html = textUtil.fromAsciiToHtml(text);

      return addHistoryItem(state, {html, type: 'text', source});
    },
    execute_result: function (state, result) {
      const data = _.get(result, 'content.data');

      if (data) {
        if (data['text/plain']) {
          const html = textUtil.fromAsciiToHtml(data['text/plain']);

          state = addHistoryItem(state, {html, source: 'stdout', type: 'text'});
        } else {
          state = addHistoryItem(state, {data, type: 'annotation'});
        }
      }

      return state;
    },
    execute_reply: function (state) {
      return state;
    },
    status: function (state, result) {
      const responseMsgId = _.get(result, 'parent_header.msg_id'),
        executionState = _.get(result, 'content.execution_state');

      if (executionState === 'busy') {
        state = state.setIn(['actives', responseMsgId], {});
      } else {
        state = state.update('actives', actives => actives.without(responseMsgId));
      }

      return addHistoryItem(state, {type: 'pageBreak'});
    },
    stream: function (state, result) {
      const source = _.get(result, 'content.name'),
        html = textUtil.fromAsciiToHtml(_.get(result, 'content.text'));

      return addHistoryItem(state, {html, type: 'text', source});
    }
  };

function addHistoryItem(state, item) {
  return state.updateIn(['items'], items => {
    return items.concat([item]);
  });
}

function executing(state) {
  return promptActionService.execute(state);
}

function executed(state, action) {
  if (state.responses) {
    return state.setIn(['responses', action.payload], {});
  }
}

/**
 * If any of the history blocks are jupyterResponse types, then they might need to be updated with new content
 * @param {Array} state
 * @param {object} action
 * @returns {Array}
 */
function jupyterResponseDetected(state, action) {
  const responseMsgId = _.get(action, 'payload.result.parent_header.msg_id');

  if (responseMsgId && state.responses && state.responses[responseMsgId]) {
    const result = _.get(action, 'payload.result'),
      responseType = _.get(result, 'msg_type');

    if (responseTypeHandlers[responseType]) {
      state = responseTypeHandlers[responseType](state, result);
    }
  }

  return state;
}

/**
 * @param {Array} state
 * @param {object} action
 * @returns {Array}
 */
function changePreference(state, action) {
  switch (action.key) {
    case 'fontSize': return state.set('fontSize', _.toNumber(action.value));
    default: return state;
  }
}

/**
 * @param {Array} state
 * @param {object} action
 * @returns {Array}
 */
function workingDirectoryChanged(state, action) {
  if (action.cwd) {
    state = state.set('cwd', action.cwd);
  }

  return state;
}

function interrupting(state) {
  return state;
}

function interrupted(state, action) {
  if (action.error) {
    console.error(action.payload);
    return addHistoryItem(state, {html: 'Unable to interrupt terminal', source: 'stderr', type: 'text'});
  }

  return state;
}

function restarting(state) {
  return addHistoryItem(state, {html: 'restarting terminal...', source: 'stdout', type: 'text'});
}

function restarted(state, action) {
  if (action.error) {
    console.error(action.payload);
    return addHistoryItem(state, {html: 'Unable to restart terminal', source: 'stderr', type: 'text'});
  }

  return addHistoryItem(state, {html: 'done', source: 'stdout', type: 'text'});
}

function clear(state) {
  return state.set('items', []);
}

/**
 * @param {Array} state
 * @returns {Array};
 */
function removeLastHistoryItem(state) {
  const items = state.items.asMutable();

  items.pop();

  return state.set('items', items);
}

function autocomplete(state, action) {
  const matches = action.payload,
    lastItem = _.last(state.items);

  if (lastItem && lastItem.type === 'autocomplete') {
    state = removeLastHistoryItem(state);
  }

  return addHistoryItem(state, {type: 'autocomplete', matches});
}

function clearAutocomplete(state) {
  const lastItem = _.last(state.items);

  if (lastItem && lastItem.type === 'autocomplete') {
    state = removeLastHistoryItem(state);
  }

  return state;
}

function promptCommand(state, action) {
  const command = action.payload;

  if (command.clearAutocomplete) {
    state = clearAutocomplete(state, action);
  }

  return state;
}

export default reduxUtil.reduceReducers(
  mapReducers(
    _.assign(reduxUtil.addPrefixToKeys(prefix, {
      AUTOCOMPLETE: autocomplete,
      CLEAR_AUTOCOMPLETE: clearAutocomplete,
      CLEAR: clear,
      INTERRUPTING: interrupting,
      INTERRUPTED: interrupted,
      EXECUTING: executing,
      EXECUTED: executed,
      RESTARTING: restarting,
      RESTARTED: restarted
    }), {
      JUPYTER_RESPONSE: jupyterResponseDetected,
      CHANGE_PREFERENCE: changePreference,
      WORKING_DIRECTORY_CHANGED: workingDirectoryChanged,
      PROMPT_VIEWER_COMMAND: promptCommand
    }), {}),
  promptViewerReducer
);
